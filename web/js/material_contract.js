// material_contract.js - shared maxjs material descriptor policy.
//
// Keep this file pure and small. It defines how exported MaxJSPBR JSON maps
// to runtime material intent; concrete loaders/builders live elsewhere.

import * as THREE from 'three';

export const FALLBACK_COLOR = 0x888888;
export const HDR_TEXTURE_EXTS = new Set(['hdr', 'exr']);
export const UTILITY_MATERIAL_MODELS = new Set([
    'MeshDepthMaterial',
    'MeshLambertMaterial',
    'MeshMatcapMaterial',
    'MeshNormalMaterial',
    'MeshPhongMaterial',
    'MeshBackdropNodeMaterial',
]);

export function finiteNumberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function firstString(...values) {
    return values.find(value => typeof value === 'string' && value.length > 0) ?? null;
}

export function colorFromArray(rgb, fallback = FALLBACK_COLOR) {
    if (Array.isArray(rgb) && rgb.length >= 3) {
        return new THREE.Color(rgb[0], rgb[1], rgb[2]);
    }
    return new THREE.Color(fallback);
}

export function pickMaterialSide(md) {
    return md?.side === 0 ? THREE.FrontSide : THREE.DoubleSide;
}

export function isBlackColorArray(value, epsilon = 1.0e-4) {
    return Array.isArray(value)
        && value.length >= 3
        && Math.abs(finiteNumberOr(value[0], 1)) <= epsilon
        && Math.abs(finiteNumberOr(value[1], 1)) <= epsilon
        && Math.abs(finiteNumberOr(value[2], 1)) <= epsilon;
}

export function hasMaterialMap(md, key) {
    return typeof md?.[key] === 'string' && md[key].trim().length > 0;
}

export function shouldRouteBlackSpecularToLambert(requestedModelName, md) {
    if (
        requestedModelName !== 'MeshPhysicalMaterial' &&
        requestedModelName !== 'MeshStandardNodeMaterial'
    ) {
        return false;
    }
    if (hasMaterialMap(md, 'specIntMap') || hasMaterialMap(md, 'specColMap') || hasMaterialMap(md, 'specMap')) {
        return false;
    }
    const blackSpecular =
        isBlackColorArray(md?.specularColor) ||
        (md?.specularIntensity != null && finiteNumberOr(md.specularIntensity, 1) <= 1.0e-4);
    if (!blackSpecular) return false;

    return finiteNumberOr(md?.metal, 0) <= 1.0e-4
        && finiteNumberOr(md?.clearcoat, 0) <= 1.0e-4
        && finiteNumberOr(md?.sheen, 0) <= 1.0e-4
        && finiteNumberOr(md?.iridescence, 0) <= 1.0e-4
        && finiteNumberOr(md?.transmission, 0) <= 1.0e-4
        && finiteNumberOr(md?.anisotropy, 0) <= 1.0e-4;
}

export function classifyRuntimeMaterial(md, THREE_NS = THREE) {
    const requestedModelName = md?.model || 'MeshStandardMaterial';
    const forceLambertForBlackSpecular = shouldRouteBlackSpecularToLambert(requestedModelName, md);
    const wantsMaterialXMaterial = requestedModelName === 'MaterialXMaterial';
    const wantsTSLMaterial = requestedModelName === 'MeshTSLNodeMaterial';
    const wantsSSSMaterial = requestedModelName === 'MeshSSSNodeMaterial';
    const wantsToonMaterial = requestedModelName === 'MeshToonMaterial';
    const wantsAdvancedMaterial =
        requestedModelName === 'MeshPhysicalMaterial' ||
        requestedModelName === 'MeshStandardNodeMaterial';
    const wantsUtilityMaterial =
        forceLambertForBlackSpecular ||
        UTILITY_MATERIAL_MODELS.has(requestedModelName);

    let runtimeModelName = 'MeshStandardMaterial';
    if (forceLambertForBlackSpecular) {
        runtimeModelName = 'MeshLambertMaterial';
    } else if (wantsMaterialXMaterial || wantsTSLMaterial || wantsSSSMaterial || wantsAdvancedMaterial) {
        runtimeModelName = 'MeshPhysicalMaterial';
    } else if (wantsUtilityMaterial) {
        runtimeModelName = typeof THREE_NS[requestedModelName] === 'function'
            ? requestedModelName
            : 'MeshLambertMaterial';
    } else if (wantsToonMaterial) {
        runtimeModelName = typeof THREE_NS.MeshToonMaterial === 'function'
            ? 'MeshToonMaterial'
            : 'MeshStandardMaterial';
    }

    return {
        requestedModelName,
        runtimeModelName,
        wantsMaterialXMaterial,
        wantsTSLMaterial,
        wantsSSSMaterial,
        wantsToonMaterial,
        wantsAdvancedMaterial,
        wantsUtilityMaterial,
        forceLambertForBlackSpecular,
        hasAdvancedSource: !!(md?.materialXInline || md?.materialXFile || md?.tslCode),
    };
}

export function getEmissiveColor(md) {
    return Array.isArray(md?.emissive) ? md.emissive : md?.em;
}

export function getEmissiveIntensity(md) {
    return Number.isFinite(md?.emissiveI) ? md.emissiveI : md?.emI;
}

export function getTextureExtension(source) {
    try {
        const url = new URL(String(source || ''), location.href);
        return (url.pathname.split('.').pop() || '').toLowerCase();
    } catch {
        const clean = String(source || '').split(/[?#]/, 1)[0];
        return (clean.split('.').pop() || '').toLowerCase();
    }
}

export function resolveTextureColorSpace(slotColorSpace, xf, url = '') {
    const ext = getTextureExtension(url);
    if (HDR_TEXTURE_EXTS.has(ext) && slotColorSpace === THREE.SRGBColorSpace) {
        return THREE.LinearSRGBColorSpace;
    }
    const cs = String(xf?.colorSpace ?? '').trim().toLowerCase();
    if (cs === 'srgb' || cs === 'srgb texture') return THREE.SRGBColorSpace;
    if (cs === 'linear' || cs === 'raw' || cs === 'data' || cs === 'non-color') {
        return slotColorSpace === THREE.NoColorSpace ? THREE.NoColorSpace : THREE.LinearSRGBColorSpace;
    }
    return slotColorSpace;
}

export function normalizeTextureTransform(xf) {
    if (!xf || typeof xf !== 'object') return null;
    return {
        scale: Number.isFinite(xf.scale) && Math.abs(xf.scale) > 1e-6 ? xf.scale : 1.0,
        tiling: [
            Number.isFinite(xf.tiling?.[0]) ? xf.tiling[0] : 1.0,
            Number.isFinite(xf.tiling?.[1]) ? xf.tiling[1] : 1.0,
        ],
        offset: [
            Number.isFinite(xf.offset?.[0]) ? xf.offset[0] : 0.0,
            Number.isFinite(xf.offset?.[1]) ? xf.offset[1] : 0.0,
        ],
        rotate: Number.isFinite(xf.rotate) ? xf.rotate : 0.0,
        center: [
            Number.isFinite(xf.center?.[0]) ? xf.center[0] : 0.5,
            Number.isFinite(xf.center?.[1]) ? xf.center[1] : 0.5,
        ],
        realWorld: !!xf.realWorld,
        realWidth: Number.isFinite(xf.realWidth) && Math.abs(xf.realWidth) > 1e-6 ? xf.realWidth : 1.0,
        realHeight: Number.isFinite(xf.realHeight) && Math.abs(xf.realHeight) > 1e-6 ? xf.realHeight : 1.0,
        wrap: typeof xf.wrap === 'string' ? xf.wrap : 'periodic',
        channel: Number.isFinite(xf.channel) ? Math.max(1, Math.round(xf.channel)) : 1,
        uvChannel: Number.isFinite(xf.uvChannel) ? Math.max(1, Math.round(xf.uvChannel)) : 1,
        invert: !!xf.invert,
        colorSpace: typeof xf.colorSpace === 'string' ? xf.colorSpace : '',
        manualGamma: Number.isFinite(xf.manualGamma) ? xf.manualGamma : 1.0,
    };
}

export function wrapModeToThree(mode) {
    switch (String(mode || 'periodic').toLowerCase()) {
        case 'mirror':
        case 'mirrored':
            return THREE.MirroredRepeatWrapping;
        case 'clamp':
        case 'black':
            return THREE.ClampToEdgeWrapping;
        case 'default':
        case 'periodic':
        default:
            return THREE.RepeatWrapping;
    }
}

export function maxMapChannelToTextureChannel(maxMapChannel, fallbackMaxChannel = 1) {
    const maxChannel = Number.isFinite(Number(maxMapChannel))
        ? Math.max(1, Math.round(Number(maxMapChannel)))
        : fallbackMaxChannel;
    return Math.max(0, maxChannel - 1);
}

export function applyTextureUvChannel(tex, maxMapChannel, fallbackMaxChannel = 1) {
    if (!tex?.isTexture) return tex;
    const nextChannel = maxMapChannelToTextureChannel(maxMapChannel, fallbackMaxChannel);
    if (tex.channel !== nextChannel) {
        tex.channel = nextChannel;
        const image = tex.source?.data ?? tex.image;
        if (image != null) tex.needsUpdate = true;
    }
    return tex;
}

export function applyTextureTransform(tex, xf) {
    if (!tex) return tex;
    tex.wrapS = tex.wrapT = wrapModeToThree(xf?.wrap);
    if (!xf) return tex;
    applyTextureUvChannel(tex, xf.uvChannel, 1);

    const worldScaleU = xf.realWorld ? xf.realWidth : 1.0;
    const worldScaleV = xf.realWorld ? xf.realHeight : 1.0;
    const repeatU = xf.tiling[0] / worldScaleU / xf.scale;
    const repeatV = xf.tiling[1] / worldScaleV / xf.scale;

    tex.repeat.set(repeatU, repeatV);
    tex.offset.set(-xf.offset[0] * repeatU, -xf.offset[1] * repeatV);
    tex.center.set(xf.center[0], xf.center[1]);
    tex.rotation = THREE.MathUtils.degToRad(xf.rotate);
    tex.updateMatrix?.();
    const image = tex.source?.data ?? tex.image;
    if (image != null) tex.needsUpdate = true;
    return tex;
}

export function applyTextureChannelSelection(tex, xf) {
    const channel = xf?.channel ?? 1;
    const invert = !!xf?.invert;
    if (channel <= 1 && !invert) return tex;

    const image = tex?.image;
    const width = image?.width ?? image?.videoWidth ?? 0;
    const height = image?.height ?? image?.videoHeight ?? 0;
    if (!width || !height || typeof document === 'undefined') return tex;

    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return tex;
        ctx.drawImage(image, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        const { data } = imageData;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            if (channel <= 1) {
                data[i] = invert ? 255 - r : r;
                data[i + 1] = invert ? 255 - g : g;
                data[i + 2] = invert ? 255 - b : b;
                data[i + 3] = a;
                continue;
            }
            let value = r;
            switch (channel) {
                case 3: value = g; break;
                case 4: value = b; break;
                case 5: value = a; break;
                case 6: value = Math.round((0.2126 * r) + (0.7152 * g) + (0.0722 * b)); break;
                case 7: value = Math.round((r + g + b) / 3); break;
                case 2:
                default: value = r; break;
            }
            if (invert) value = 255 - value;
            data[i] = value;
            data[i + 1] = value;
            data[i + 2] = value;
            data[i + 3] = channel === 5 ? value : a;
        }
        ctx.putImageData(imageData, 0, 0);
        tex.image = canvas;
        tex.needsUpdate = true;
    } catch (error) {
        console.warn('[material_contract] channel extraction failed:', error);
    }
    return tex;
}

export function optimizedTextureTransformForSlot(key, xf) {
    const normalized = normalizeTextureTransform(xf);
    if (!normalized) return null;
    const nativeChannels = {
        aoMap: 2,
        roughMap: 3,
        ccRoughMap: 3,
        metalMap: 4,
    };
    if (nativeChannels[key] === normalized.channel && !normalized.invert) {
        return { ...normalized, channel: 1 };
    }
    return normalized;
}

export function textureReadyForMaterialBinding(tex) {
    if (!tex?.isTexture) return false;
    const image = tex.source?.data ?? tex.image;
    if (!image) return false;
    return image.complete !== false;
}
