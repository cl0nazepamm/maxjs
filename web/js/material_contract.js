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

// Material texture properties whose default sampling path reads geometry UV0.
// Directional textures such as envMap/matcap and generated lookup textures are
// intentionally absent. Texture.channel is honored so light/ao maps routed to
// uv1 do not allocate an unnecessary uv attribute.
const UV0_TEXTURE_PROPERTIES = Object.freeze([
    'map',
    'alphaMap',
    'aoMap',
    'bumpMap',
    'normalMap',
    'displacementMap',
    'emissiveMap',
    'metalnessMap',
    'roughnessMap',
    'lightMap',
    'specularMap',
    'specularIntensityMap',
    'specularColorMap',
    'clearcoatMap',
    'clearcoatRoughnessMap',
    'clearcoatNormalMap',
    'iridescenceMap',
    'iridescenceThicknessMap',
    'sheenColorMap',
    'sheenRoughnessMap',
    'transmissionMap',
    'thicknessMap',
    'anisotropyMap',
]);
const SYNTHETIC_UV0_ATTRIBUTE_NAME = 'maxjs.syntheticUv0';

export function isSyntheticUv0Attribute(attribute) {
    return attribute?.maxjsSyntheticUv0 === true || attribute?.name === SYNTHETIC_UV0_ATTRIBUTE_NAME;
}

export function markUv0AttributeAuthored(attribute) {
    if (!attribute) return;
    if (attribute.name === SYNTHETIC_UV0_ATTRIBUTE_NAME) attribute.name = '';
    delete attribute.maxjsSyntheticUv0;
}

export function materialUsesUv0(material) {
    if (Array.isArray(material)) return material.some(materialUsesUv0);
    if (!material) return false;
    return UV0_TEXTURE_PROPERTIES.some((property) => {
        const texture = material[property];
        if (!texture?.isTexture) return false;
        const channel = Number(texture.channel);
        return !Number.isFinite(channel) || channel === 0;
    });
}

// Three's AttributeNode substitutes a constant zero when a requested vertex
// attribute is absent, but emits one warning for every compiled material. Make
// that fallback explicit only for materials that actually sample UV0. The
// rendered result stays identical while untextured UV-less meshes remain free
// of the additional per-vertex allocation.
export function ensureGeometryUv0ForMaterial(geometry, material) {
    if (!geometry || !materialUsesUv0(material)) return false;
    const position = geometry.getAttribute?.('position');
    if (!position || !Number.isInteger(position.count) || position.count <= 0) return false;
    const currentUv = geometry.getAttribute?.('uv');
    if (currentUv && (!isSyntheticUv0Attribute(currentUv) || currentUv.count === position.count)) return false;
    const fallbackUv = new THREE.BufferAttribute(new Float32Array(position.count * 2), 2);
    fallbackUv.name = SYNTHETIC_UV0_ATTRIBUTE_NAME;
    fallbackUv.maxjsSyntheticUv0 = true;
    geometry.setAttribute('uv', fallbackUv);
    return true;
}

// three derives USE_SHEEN / USE_CLEARCOAT / USE_IRIDESCENCE / USE_ANISOTROPY /
// USE_TRANSMISSION / USE_DISPERSION from `value > 0` when the program is built
// (the HAS_* block in acquireProgram), and `needsProgramChange` has no branch
// for any of them. Crossing zero therefore has to bump the material version or
// the lobe is set but never compiled in. Shared so the live viewer and the
// snapshot player make the identical decision — this is a parity rule, not a
// per-host detail.
export const PROGRAM_GATED_MATERIAL_SCALARS = Object.freeze([
    'sheen', 'clearcoat', 'iridescence', 'anisotropy', 'transmission', 'dispersion',
]);

const PROGRAM_GATED_MATERIAL_SCALAR_SET = new Set(PROGRAM_GATED_MATERIAL_SCALARS);

export function isProgramGatedMaterialScalar(key) {
    return PROGRAM_GATED_MATERIAL_SCALAR_SET.has(key);
}

// Assigns a program-gated scalar and reports whether the material now needs a
// rebuild. Returns false for no-ops so callers never recompile needlessly.
export function assignGatedMaterialScalar(material, key, value) {
    if (!material || value == null || !(key in material)) return false;
    const next = Number(value);
    if (!Number.isFinite(next)) return false;
    const wasActive = (material[key] ?? 0) > 0;
    material[key] = next;
    return wasActive !== (next > 0);
}

// Max's Normal Bump exposes flipred/flipgreen/swap_rg for DirectX-vs-OpenGL
// convention. The wire carries a scalar normScl, so the flips ride as flags and
// become the sign of each normalScale component here — shared so the live viewer
// and the snapshot player expand them identically.
export function normalScaleVectorFromDescriptor(md, THREE_NS = THREE) {
    const scale = Number(md?.normScl);
    if (!Number.isFinite(scale)) return null;
    return new THREE_NS.Vector2(
        md?.normFlipR ? -scale : scale,
        md?.normFlipG ? -scale : scale,
    );
}

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
    } else if (wantsSSSMaterial && typeof THREE_NS.MeshSSSNodeMaterial === 'function') {
        runtimeModelName = 'MeshSSSNodeMaterial';
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

function normalizeOutputLut(value) {
    if (!Array.isArray(value) || value.length < 2) return null;
    return value.map(entry => {
        const n = Number(entry);
        return Number.isFinite(n) ? n : 0;
    });
}

export function normalizeTextureTransform(xf) {
    if (!xf || typeof xf !== 'object') return null;
    const normalized = {
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
    // Video playback fields must survive normalization: the slot loaders
    // normalize before they reach loadVideoTexture, so dropping these silently
    // forced every video map to loop, mute and play at 1x.
    if (xf.video) {
        normalized.video = true;
        normalized.loop = xf.loop !== false;
        normalized.muted = xf.muted !== false;
        normalized.rate = Number.isFinite(Number(xf.rate)) ? Number(xf.rate) : 1.0;
    }
    // Max Output rollout data is attached only when present so cache keys and
    // material hashes stay byte-identical for the common no-output case.
    const outLut = normalizeOutputLut(xf.outLut);
    const outLutR = normalizeOutputLut(xf.outLutR);
    if (outLut) normalized.outLut = outLut;
    if (outLutR) {
        normalized.outLutR = outLutR;
        normalized.outLutG = normalizeOutputLut(xf.outLutG) ?? outLutR;
        normalized.outLutB = normalizeOutputLut(xf.outLutB) ?? outLutR;
    }
    if (xf.alphaFromRGB) normalized.alphaFromRGB = true;
    return normalized;
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

// Lightmap UV channel resolution. The bake system names its output with a
// _UV1/_UV2 token, so that token has to outrank lmCh -- lmCh defaults to 2 and
// is emitted whenever lmI > 0 (the default), which would otherwise force uv1 on
// a lightmap explicitly baked to uv0. Shared because the live viewer and the
// snapshot builder must land on the SAME channel: they disagreed before, and a
// bake-system-generated `*_UV1.png` sampled uv0 live and uv1 in the snapshot.
export function explicitMaxMapChannelFromName(value) {
    let filename = String(value ?? '');
    try {
        const base = typeof location !== 'undefined' ? location.href : 'http://maxjs.local/';
        const parsed = new URL(filename, base);
        filename = parsed.pathname || filename;
    } catch {}
    filename = filename.replace(/\\/g, '/').split('/').pop() || filename;
    const baseName = filename.replace(/\.[^./\\]+$/, '');
    const match = baseName.match(/(?:^|[_.\-\s])UV([12])(?:$|[_.\-\s])/i);
    return match ? Number(match[1]) : null;
}

export function resolveLightMapMaxMapChannel(md) {
    const explicit = explicitMaxMapChannelFromName(md?.lmMap ?? md?.lightMap ?? '');
    if (explicit === 1 || explicit === 2) return explicit;
    if (Number.isFinite(Number(md?.lmCh))) return Math.max(1, Math.round(Number(md.lmCh)));
    const xf = normalizeTextureTransform(md?.lmMapXf ?? md?.lightMapXf);
    if (Number.isFinite(Number(xf?.uvChannel))) return Math.max(1, Math.round(Number(xf.uvChannel)));
    return 2;
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

// ── Max Output rollout (Invert/Clamp/RGB Level/Offset/Color Map) ──
// The C++ side bakes the whole StdTexoutGen transfer into 256-entry float LUTs
// (mono `outLut` or per-channel `outLutR/G/B`) sampled in Max's linear domain.
// Here they collapse into byte→byte tables: for sRGB-encoded textures the
// stored byte is decoded to linear, pushed through the LUT, and re-encoded so
// the GPU's sRGB decode lands on Max's filtered linear value.

function srgbByteToLinearUnit(x) {
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearUnitToSrgb(x) {
    return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function sampleOutputLut(lut, x) {
    const pos = x * (lut.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(lut.length - 1, i0 + 1);
    return lut[i0] + (lut[i1] - lut[i0]) * (pos - i0);
}

function outputFilterFingerprint(luts, alphaFromRGB, srgbEncoded, manualGamma) {
    const payload = `${JSON.stringify(luts)}:${alphaFromRGB ? 1 : 0}:${srgbEncoded ? 1 : 0}:${manualGamma}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
        hash ^= payload.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
}

export function buildOutputFilter(xf, srgbEncoded) {
    const mono = Array.isArray(xf?.outLut) && xf.outLut.length >= 2 ? xf.outLut : null;
    const lutR = Array.isArray(xf?.outLutR) && xf.outLutR.length >= 2 ? xf.outLutR : mono;
    const alphaFromRGB = !!xf?.alphaFromRGB;
    // Max's Bitmap "Manual Gamma" override REPLACES the file's decode: the
    // stored value is read as stored^gamma rather than through the standard
    // sRGB curve. It was emitted and normalized but never applied, so the
    // control silently did nothing. Fold it into the same byte->byte table the
    // Output rollout already uses.
    const rawGamma = Number(xf?.manualGamma);
    const manualGamma = Number.isFinite(rawGamma) && rawGamma > 0 && Math.abs(rawGamma - 1.0) > 1.0e-6
        ? rawGamma
        : 0;
    if (!lutR && !alphaFromRGB && !manualGamma) return null;
    const lutG = Array.isArray(xf?.outLutG) && xf.outLutG.length >= 2 ? xf.outLutG : lutR;
    const lutB = Array.isArray(xf?.outLutB) && xf.outLutB.length >= 2 ? xf.outLutB : lutR;

    // tables: filtered bytes in the texture's stored encoding (written back to
    // the image). linTables: filtered bytes in linear, used for alpha-from-RGB
    // intensity, which the GPU never sRGB-decodes.
    const tables = new Uint8Array(768);
    const linTables = srgbEncoded && alphaFromRGB ? new Uint8Array(768) : null;
    const luts = [lutR, lutG, lutB];
    for (let i = 0; i < 256; i++) {
        const stored = i / 255;
        const x = manualGamma
            ? Math.pow(stored, manualGamma)
            : (srgbEncoded ? srgbByteToLinearUnit(stored) : stored);
        for (let ch = 0; ch < 3; ch++) {
            const lut = luts[ch];
            let y = lut ? sampleOutputLut(lut, x) : x;
            y = Math.min(1, Math.max(0, y));
            if (linTables) linTables[ch * 256 + i] = Math.round(y * 255);
            if (srgbEncoded) y = linearUnitToSrgb(y);
            tables[ch * 256 + i] = Math.round(y * 255);
        }
    }
    return {
        tables,
        linTables,
        alphaFromRGB,
        key: outputFilterFingerprint([lutR, lutG, lutB], alphaFromRGB, srgbEncoded, manualGamma),
    };
}

function writeSelectedChannelBytes(r, g, b, a, channel, invert, out, outIndex, output) {
    if (output) {
        const tables = output.tables;
        if (output.alphaFromRGB) {
            const lin = output.linTables || tables;
            a = Math.round((lin[r] + lin[256 + g] + lin[512 + b]) / 3);
        }
        const fr = tables[r];
        const fg = tables[256 + g];
        const fb = tables[512 + b];
        r = fr; g = fg; b = fb;
    }
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

function writeSelectedTypedTextureChannel(data, pixelIndex, componentCount, tex, channel, invert, out, outIndex, output) {
    const base = pixelIndex * componentCount;
    const r = textureComponentToByte(data, base, tex);
    const g = componentCount > 1 ? textureComponentToByte(data, base + 1, tex) : r;
    const b = componentCount > 2 ? textureComponentToByte(data, base + 2, tex) : r;
    const a = componentCount > 3 ? textureComponentToByte(data, base + 3, tex) : 255;
    writeSelectedChannelBytes(r, g, b, a, channel, invert, out, outIndex, output);
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

function applyTypedTextureChannelSelection(tex, image, channel, invert, signature, output) {
    const width = image.width;
    const height = image.height;
    const pixelCount = width * height;
    const source = image.data;
    const componentCount = Math.max(1, Math.floor(source.length / pixelCount));
    if (!pixelCount || !componentCount) return false;

    const out = new Uint8Array(pixelCount * 4);
    for (let pixel = 0, outIndex = 0; pixel < pixelCount; pixel += 1, outIndex += 4) {
        writeSelectedTypedTextureChannel(source, pixel, componentCount, tex, channel, invert, out, outIndex, output);
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

function writeBytes(r, g, b, a, channel, invert, out, outIndex, tables, linTables, alphaFromRGB) {
  if (tables) {
    if (alphaFromRGB) {
      const lin = linTables || tables;
      a = Math.round((lin[r] + lin[256 + g] + lin[512 + b]) / 3);
    }
    const fr = tables[r];
    const fg = tables[256 + g];
    const fb = tables[512 + b];
    r = fr; g = fg; b = fb;
  }
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
      writeBytes(r, g, b, a, job.channel, job.invert, out, outIndex, job.tables, job.linTables, job.alphaFromRGB);
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

function channelSelectionKey(image, channel, invert, output) {
    return `${image?.width || 0}x${image?.height || 0}:${image?.data?.length || 0}:${channel}:${invert ? 1 : 0}:${output?.key || ''}`;
}

function hasCompletedChannelSelection(tex, image, signature) {
    const completed = completedChannelSelections.get(tex);
    return completed?.image === image && completed?.signature === signature;
}

function scheduleTypedTextureChannelSelection(tex, image, channel, invert, output) {
    const width = image.width;
    const height = image.height;
    const pixelCount = width * height;
    const source = image.data;
    if (!pixelCount || !source?.length) return false;

    const signature = `typed:${channelSelectionKey(image, channel, invert, output)}`;
    if (hasCompletedChannelSelection(tex, image, signature)) return true;
    if (pendingChannelSelections.has(tex)) return true;
    pendingChannelSelections.set(tex, signature);

    const worker = createChannelExtractionWorker();
    if (!worker) return applyTypedTextureChannelSelection(tex, image, channel, invert, signature, output);

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
            tables: output?.tables || null,
            linTables: output?.linTables || null,
            alphaFromRGB: !!output?.alphaFromRGB,
        }, [sourceBuffer]);
        installPendingChannelTexture(tex, pendingImage);
    } catch (error) {
        pendingChannelWorkerJobs.delete(id);
        console.warn('[material_contract] channel extraction worker transfer failed:', error);
        pendingChannelSelections.set(tex, signature);
        return applyTypedTextureChannelSelection(tex, image, channel, invert, signature, output);
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

function applyCanvasChannelSelection(tex, image, width, height, channel, invert, signature, output) {
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
        writeSelectedChannelBytes(r, g, b, a, channel, invert, data, i, output);
    }
    ctx.putImageData(imageData, 0, 0);
    tex.image = canvas;
    tex.needsUpdate = true;
    if (signature) completedChannelSelections.set(tex, { image: canvas, signature });
    return true;
}

function canvasChannelSelectionKey(width, height, channel, invert, output) {
    return `canvas:${width}x${height}:${channel}:${invert ? 1 : 0}:${output?.key || ''}`;
}

function scheduleCanvasChannelSelection(tex, image, width, height, channel, invert, output) {
    const signature = canvasChannelSelectionKey(width, height, channel, invert, output);
    if (hasCompletedChannelSelection(tex, image, signature)) return true;
    if (pendingChannelSelections.has(tex)) return true;
    pendingChannelSelections.set(tex, signature);
    scheduleDeferredTask(() => {
        if (pendingChannelSelections.get(tex) !== signature) return;
        try {
            if (tex.image === image) applyCanvasChannelSelection(tex, image, width, height, channel, invert, signature, output);
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
    // Output-rollout LUTs operate in Max's linear domain; sRGB-stored textures
    // are decoded/re-encoded around the LUT so the GPU sees matching values.
    const output = buildOutputFilter(xf, tex?.colorSpace === THREE.SRGBColorSpace);
    if (channel <= 1 && !invert && !output) return tex;

    const image = tex?.image;
    if (isVideoTextureImage(image)) return tex;
    const width = image?.width ?? image?.videoWidth ?? 0;
    const height = image?.height ?? image?.videoHeight ?? 0;
    if (!width || !height) return tex;

    if (isTypedTextureImage(image)) {
        scheduleTypedTextureChannelSelection(tex, image, channel, invert, output);
        return tex;
    }

    const pixelCount = width * height;
    if (typeof document === 'undefined' || !isDrawableImageSource(image)) return tex;
    const signature = canvasChannelSelectionKey(width, height, channel, invert, output);
    if (hasCompletedChannelSelection(tex, image, signature)) return tex;
    if (pixelCount > MAX_SYNC_DRAWABLE_CHANNEL_EXTRACTION_PIXELS) {
        scheduleCanvasChannelSelection(tex, image, width, height, channel, invert, output);
        return tex;
    }

    try {
        applyCanvasChannelSelection(tex, image, width, height, channel, invert, signature, output);
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
