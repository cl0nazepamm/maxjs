// material_contract.js - shared maxjs material descriptor policy.
//
// Keep this file pure and small. It defines how exported MaxJSPBR JSON maps
// to runtime material intent; concrete loaders/builders live elsewhere.

import * as THREE from 'three';

export const FALLBACK_COLOR = 0x888888;
export const HDR_TEXTURE_EXTS = new Set(['hdr', 'exr']);
const MAX_SYNC_DRAWABLE_CHANNEL_EXTRACTION_PIXELS = 512 * 512;
const pendingChannelSelections = new WeakMap();
const pendingChannelWorkerJobs = new Map();
const completedChannelSelections = new WeakMap();
let channelExtractionWorker = null;
let nextChannelWorkerJobId = 1;
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

function isVideoTextureImage(image) {
    return typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement;
}

function canUploadVideoFrame(image) {
    if (!isVideoTextureImage(image)) return true;
    return !image.error &&
        !image.seeking &&
        image.readyState >= image.HAVE_CURRENT_DATA &&
        image.videoWidth > 0 &&
        image.videoHeight > 0;
}

function markTextureUploadReady(tex, image = tex?.source?.data ?? tex?.image) {
    if (image == null) return;
    if (!canUploadVideoFrame(image)) return;
    if (tex.source) tex.source.dataReady = true;
    tex.needsUpdate = true;
}

export function applyTextureUvChannel(tex, maxMapChannel, fallbackMaxChannel = 1) {
    if (!tex?.isTexture) return tex;
    const nextChannel = maxMapChannelToTextureChannel(maxMapChannel, fallbackMaxChannel);
    if (tex.channel !== nextChannel) {
        tex.channel = nextChannel;
        markTextureUploadReady(tex);
    }
    return tex;
}

export function maxMapChannelFromMapName(value, fallbackMaxChannel = 2) {
    const fallback = Number.isFinite(Number(fallbackMaxChannel))
        ? Math.max(1, Math.round(Number(fallbackMaxChannel)))
        : 2;
    let filename = String(value ?? '');
    try {
        const baseUrl = typeof location !== 'undefined' ? location.href : 'http://maxjs.local/';
        const parsed = new URL(filename, baseUrl);
        filename = parsed.pathname.split('/').pop() || filename;
    } catch {
        filename = filename.split(/[?#]/, 1)[0].split(/[\\/]/).pop() || filename;
    }
    try {
        filename = decodeURIComponent(filename);
    } catch {}
    const baseName = filename.replace(/\.[^./\\]+$/, '');
    const match = baseName.match(/(?:^|[_.\-\s])UV([12])(?:$|[_.\-\s])/i);
    return match ? Number(match[1]) : fallback;
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
    markTextureUploadReady(tex);
    return tex;
}

function isTypedTextureImage(image) {
    return image?.data && ArrayBuffer.isView(image.data) && image.width > 0 && image.height > 0;
}

function halfFloatToNumber(value) {
    return THREE.DataUtils?.fromHalfFloat ? THREE.DataUtils.fromHalfFloat(value) : value / 65535;
}

function textureComponentToByte(data, index, tex) {
    const raw = data[index];
    if (!Number.isFinite(raw)) return 0;
    if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) return raw;
    if (data instanceof Uint16Array) {
        if (tex?.type === THREE.HalfFloatType) {
            return Math.round(THREE.MathUtils.clamp(halfFloatToNumber(raw), 0, 1) * 255);
        }
        return Math.round(THREE.MathUtils.clamp(raw / 65535, 0, 1) * 255);
    }
    if (data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array || data instanceof Uint32Array) {
        return Math.round(THREE.MathUtils.clamp(raw, 0, 255));
    }
    return Math.round(THREE.MathUtils.clamp(raw, 0, 1) * 255);
}

function writeSelectedChannelBytes(r, g, b, a, channel, invert, out, outIndex) {
    if (channel <= 1) {
        out[outIndex] = invert ? 255 - r : r;
        out[outIndex + 1] = invert ? 255 - g : g;
        out[outIndex + 2] = invert ? 255 - b : b;
        out[outIndex + 3] = a;
        return;
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
    out[outIndex] = value;
    out[outIndex + 1] = value;
    out[outIndex + 2] = value;
    out[outIndex + 3] = channel === 5 ? value : a;
}

function writeSelectedTypedTextureChannel(data, pixelIndex, componentCount, tex, channel, invert, out, outIndex) {
    const base = pixelIndex * componentCount;
    const r = textureComponentToByte(data, base, tex);
    const g = componentCount > 1 ? textureComponentToByte(data, base + 1, tex) : r;
    const b = componentCount > 2 ? textureComponentToByte(data, base + 2, tex) : r;
    const a = componentCount > 3 ? textureComponentToByte(data, base + 3, tex) : 255;
    writeSelectedChannelBytes(r, g, b, a, channel, invert, out, outIndex);
}

function applyChannelTexture(tex, image, out, signature) {
    if (pendingChannelSelections.get(tex) !== signature) return;
    const convertedImage = { data: out, width: image.width, height: image.height };
    tex.image = convertedImage;
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.internalFormat = null;
    tex.needsUpdate = true;
    completedChannelSelections.set(tex, { image: convertedImage, signature });
    pendingChannelSelections.delete(tex);
}

function applyTypedTextureChannelSelection(tex, image, channel, invert, signature) {
    const width = image.width;
    const height = image.height;
    const pixelCount = width * height;
    const source = image.data;
    const componentCount = Math.max(1, Math.floor(source.length / pixelCount));
    if (!pixelCount || !componentCount) return false;

    const out = new Uint8Array(pixelCount * 4);
    for (let pixel = 0, outIndex = 0; pixel < pixelCount; pixel += 1, outIndex += 4) {
        writeSelectedTypedTextureChannel(source, pixel, componentCount, tex, channel, invert, out, outIndex);
    }
    applyChannelTexture(tex, image, out, signature);
    return true;
}

function installPendingChannelTexture(tex, pendingImage) {
    tex.image = pendingImage;
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.internalFormat = null;
    tex.needsUpdate = true;
}

function createChannelExtractionWorker() {
    if (channelExtractionWorker) return channelExtractionWorker;
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return null;

    const workerSource = `
const ARRAY_TYPES = {
  Uint8Array, Uint8ClampedArray, Uint16Array, Int8Array, Int16Array, Int32Array, Uint32Array, Float32Array, Float64Array
};

function halfFloatToNumber(value) {
  const s = (value & 0x8000) >> 15;
  const e = (value & 0x7c00) >> 10;
  const f = value & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : ((s ? -1 : 1) * Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function componentToByte(data, index, sourceType, isHalfFloat) {
  const raw = data[index];
  if (!Number.isFinite(raw)) return 0;
  if (sourceType === 'Uint8Array' || sourceType === 'Uint8ClampedArray') return raw;
  if (sourceType === 'Uint16Array') {
    return Math.round(clamp01(isHalfFloat ? halfFloatToNumber(raw) : raw / 65535) * 255);
  }
  if (sourceType === 'Int8Array' || sourceType === 'Int16Array' || sourceType === 'Int32Array' || sourceType === 'Uint32Array') {
    return Math.round(Math.min(255, Math.max(0, raw)));
  }
  return Math.round(clamp01(raw) * 255);
}

function writeBytes(r, g, b, a, channel, invert, out, outIndex) {
  if (channel <= 1) {
    out[outIndex] = invert ? 255 - r : r;
    out[outIndex + 1] = invert ? 255 - g : g;
    out[outIndex + 2] = invert ? 255 - b : b;
    out[outIndex + 3] = a;
    return;
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
  out[outIndex] = value;
  out[outIndex + 1] = value;
  out[outIndex + 2] = value;
  out[outIndex + 3] = channel === 5 ? value : a;
}

self.onmessage = event => {
  const job = event.data;
  try {
    const TypedArray = ARRAY_TYPES[job.sourceType] || Float32Array;
    const sourceLength = Math.floor(job.sourceByteLength / TypedArray.BYTES_PER_ELEMENT);
    const source = new TypedArray(job.sourceBuffer, job.sourceByteOffset || 0, sourceLength);
    const pixelCount = job.width * job.height;
    const componentCount = Math.max(1, Math.floor(source.length / pixelCount));
    const out = new Uint8Array(pixelCount * 4);
    for (let pixel = 0, outIndex = 0; pixel < pixelCount; pixel += 1, outIndex += 4) {
      const base = pixel * componentCount;
      const r = componentToByte(source, base, job.sourceType, job.isHalfFloat);
      const g = componentCount > 1 ? componentToByte(source, base + 1, job.sourceType, job.isHalfFloat) : r;
      const b = componentCount > 2 ? componentToByte(source, base + 2, job.sourceType, job.isHalfFloat) : r;
      const a = componentCount > 3 ? componentToByte(source, base + 3, job.sourceType, job.isHalfFloat) : 255;
      writeBytes(r, g, b, a, job.channel, job.invert, out, outIndex);
    }
    self.postMessage({ id: job.id, width: job.width, height: job.height, buffer: out.buffer }, [out.buffer]);
  } catch (error) {
    self.postMessage({ id: job.id, error: String(error && error.message || error) });
  }
};
`;

    try {
        const blob = new Blob([workerSource], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        channelExtractionWorker = new Worker(url);
        channelExtractionWorker.onmessage = (event) => {
            const { id, width, height, buffer, error } = event.data || {};
            const job = pendingChannelWorkerJobs.get(id);
            if (!job) return;
            pendingChannelWorkerJobs.delete(id);
            if (error) {
                console.warn('[material_contract] channel extraction failed:', error);
                if (pendingChannelSelections.get(job.tex) === job.signature) {
                    pendingChannelSelections.delete(job.tex);
                }
                return;
            }
            if (pendingChannelSelections.get(job.tex) !== job.signature) return;
            if (job.tex.image !== job.pendingImage) {
                pendingChannelSelections.delete(job.tex);
                return;
            }
            const convertedImage = { data: new Uint8Array(buffer), width, height };
            job.tex.image = convertedImage;
            job.tex.format = THREE.RGBAFormat;
            job.tex.type = THREE.UnsignedByteType;
            job.tex.internalFormat = null;
            job.tex.needsUpdate = true;
            completedChannelSelections.set(job.tex, { image: convertedImage, signature: job.signature });
            pendingChannelSelections.delete(job.tex);
        };
        channelExtractionWorker.onerror = (error) => {
            console.warn('[material_contract] channel extraction worker failed:', error);
        };
    } catch (error) {
        console.warn('[material_contract] channel extraction worker unavailable:', error);
        channelExtractionWorker = null;
    }
    return channelExtractionWorker;
}

function channelSelectionKey(image, channel, invert) {
    return `${image?.width || 0}x${image?.height || 0}:${image?.data?.length || 0}:${channel}:${invert ? 1 : 0}`;
}

function hasCompletedChannelSelection(tex, image, signature) {
    const completed = completedChannelSelections.get(tex);
    return completed?.image === image && completed?.signature === signature;
}

function scheduleTypedTextureChannelSelection(tex, image, channel, invert) {
    const width = image.width;
    const height = image.height;
    const pixelCount = width * height;
    const source = image.data;
    if (!pixelCount || !source?.length) return false;

    const signature = `typed:${channelSelectionKey(image, channel, invert)}`;
    if (hasCompletedChannelSelection(tex, image, signature)) return true;
    if (pendingChannelSelections.has(tex)) return true;
    pendingChannelSelections.set(tex, signature);

    const worker = createChannelExtractionWorker();
    if (!worker) return applyTypedTextureChannelSelection(tex, image, channel, invert, signature);

    const id = nextChannelWorkerJobId++;
    const pendingImage = { data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 };
    const sourceBuffer = source.buffer;
    pendingChannelWorkerJobs.set(id, { tex, pendingImage, signature });
    try {
        worker.postMessage({
            id,
            width,
            height,
            sourceType: source.constructor?.name || 'Float32Array',
            sourceBuffer,
            sourceByteOffset: source.byteOffset,
            sourceByteLength: source.byteLength,
            isHalfFloat: tex?.type === THREE.HalfFloatType,
            channel,
            invert,
        }, [sourceBuffer]);
        installPendingChannelTexture(tex, pendingImage);
    } catch (error) {
        pendingChannelWorkerJobs.delete(id);
        console.warn('[material_contract] channel extraction worker transfer failed:', error);
        pendingChannelSelections.set(tex, signature);
        return applyTypedTextureChannelSelection(tex, image, channel, invert, signature);
    }
    return true;
}

function scheduleDeferredTask(callback) {
    setTimeout(callback, 0);
}

function isDrawableImageSource(image) {
    if (!image) return false;
    return (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) ||
        (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) ||
        (typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement) ||
        (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ||
        (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) ||
        (typeof SVGImageElement !== 'undefined' && image instanceof SVGImageElement) ||
        (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame);
}

function applyCanvasChannelSelection(tex, image, width, height, channel, invert, signature) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        writeSelectedChannelBytes(r, g, b, a, channel, invert, data, i);
    }
    ctx.putImageData(imageData, 0, 0);
    tex.image = canvas;
    tex.needsUpdate = true;
    if (signature) completedChannelSelections.set(tex, { image: canvas, signature });
    return true;
}

function scheduleCanvasChannelSelection(tex, image, width, height, channel, invert) {
    const signature = `canvas:${width}x${height}:${channel}:${invert ? 1 : 0}`;
    if (hasCompletedChannelSelection(tex, image, signature)) return true;
    if (pendingChannelSelections.has(tex)) return true;
    pendingChannelSelections.set(tex, signature);
    scheduleDeferredTask(() => {
        if (pendingChannelSelections.get(tex) !== signature) return;
        try {
            if (tex.image === image) applyCanvasChannelSelection(tex, image, width, height, channel, invert, signature);
        } catch (error) {
            console.warn('[material_contract] channel extraction failed:', error);
        } finally {
            if (pendingChannelSelections.get(tex) === signature) pendingChannelSelections.delete(tex);
        }
    });
    return true;
}

export function applyTextureChannelSelection(tex, xf) {
    const channel = xf?.channel ?? 1;
    const invert = !!xf?.invert;
    if (channel <= 1 && !invert) return tex;

    const image = tex?.image;
    if (isVideoTextureImage(image)) return tex;
    const width = image?.width ?? image?.videoWidth ?? 0;
    const height = image?.height ?? image?.videoHeight ?? 0;
    if (!width || !height) return tex;

    if (isTypedTextureImage(image)) {
        scheduleTypedTextureChannelSelection(tex, image, channel, invert);
        return tex;
    }

    const pixelCount = width * height;
    if (typeof document === 'undefined' || !isDrawableImageSource(image)) return tex;
    const signature = `canvas:${width}x${height}:${channel}:${invert ? 1 : 0}`;
    if (hasCompletedChannelSelection(tex, image, signature)) return tex;
    if (pixelCount > MAX_SYNC_DRAWABLE_CHANNEL_EXTRACTION_PIXELS) {
        scheduleCanvasChannelSelection(tex, image, width, height, channel, invert);
        return tex;
    }

    try {
        applyCanvasChannelSelection(tex, image, width, height, channel, invert, signature);
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
    if (isVideoTextureImage(image)) return canUploadVideoFrame(image);
    return image.complete !== false;
}
