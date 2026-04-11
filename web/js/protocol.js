export const DELTA_FRAME_MAGIC = 0x424a584d;
export const DELTA_FRAME_VERSION = 1;

export const COMMAND_TYPES = Object.freeze({
    BeginFrame: 1,
    UpdateTransform: 2,
    UpdateMaterialScalar: 3,
    UpdateSelection: 4,
    UpdateVisibility: 5,
    UpdateCamera: 6,
    EndFrame: 7,
    UpdateLight: 8,
    UpdateSplat: 9,
    UpdateAudio: 10,
});

function assertSize(type, actual, expected) {
    if (actual !== expected) {
        throw new Error(`Unexpected command size for ${type}: ${actual} != ${expected}`);
    }
}

export function applyDeltaFrame(buffer, handlers = {}) {
    const view = new DataView(buffer);
    let offset = 0;

    const magic = view.getUint32(offset, true);
    offset += 4;
    if (magic !== DELTA_FRAME_MAGIC) {
        throw new Error(`Unexpected delta frame magic: 0x${magic.toString(16)}`);
    }

    const version = view.getUint16(offset, true);
    offset += 2;
    if (version !== DELTA_FRAME_VERSION) {
        throw new Error(`Unsupported delta frame version: ${version}`);
    }

    offset += 2; // reserved
    const frameId = view.getUint32(offset, true);
    offset += 4;
    const commandCount = view.getUint32(offset, true);
    offset += 4;

    let decodeMs = 0;
    let applyMs = 0;

    for (let i = 0; i < commandCount; i++) {
        const type = view.getUint16(offset, true);
        const commandSize = view.getUint16(offset + 2, true);
        const payloadOffset = offset + 4;
        const payloadSize = commandSize - 4;

        const decodeStart = performance.now();
        switch (type) {
            case COMMAND_TYPES.BeginFrame: {
                assertSize('BeginFrame', commandSize, 8);
                const beginFrameId = view.getUint32(payloadOffset, true);
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onBeginFrame?.(beginFrameId);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateTransform: {
                assertSize('UpdateTransform', commandSize, 72);
                const nodeHandle = view.getUint32(payloadOffset, true);
                const matrix = new Float32Array(buffer, payloadOffset + 4, 16);
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onTransform?.(nodeHandle, matrix);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateMaterialScalar: {
                assertSize('UpdateMaterialScalar', commandSize, 32);
                const nodeHandle = view.getUint32(payloadOffset, true);
                const color = new Float32Array(buffer, payloadOffset + 4, 3);
                const rough = view.getFloat32(payloadOffset + 16, true);
                const metal = view.getFloat32(payloadOffset + 20, true);
                const opacity = view.getFloat32(payloadOffset + 24, true);
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onMaterialScalar?.(nodeHandle, { color, rough, metal, opacity });
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateSelection: {
                assertSize('UpdateSelection', commandSize, 12);
                const nodeHandle = view.getUint32(payloadOffset, true);
                const selected = view.getUint32(payloadOffset + 4, true) !== 0;
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onSelection?.(nodeHandle, selected);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateVisibility: {
                assertSize('UpdateVisibility', commandSize, 12);
                const nodeHandle = view.getUint32(payloadOffset, true);
                const visible = view.getUint32(payloadOffset + 4, true) !== 0;
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onVisibility?.(nodeHandle, visible);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateCamera: {
                const pos = new Float32Array(buffer, payloadOffset, 3);
                const tgt = new Float32Array(buffer, payloadOffset + 12, 3);
                const up = new Float32Array(buffer, payloadOffset + 24, 3);
                const fov = view.getFloat32(payloadOffset + 36, true);
                const persp = view.getUint32(payloadOffset + 40, true) !== 0;
                const viewWidth = view.getFloat32(payloadOffset + 44, true);
                const hasDof = commandSize >= 68;
                const dofEnabled = hasDof ? view.getUint32(payloadOffset + 48, true) !== 0 : undefined;
                const dofFocusDistance = hasDof ? view.getFloat32(payloadOffset + 52, true) : 0;
                const dofFocalLength = hasDof ? view.getFloat32(payloadOffset + 56, true) : 0;
                const dofBokehScale = hasDof ? view.getFloat32(payloadOffset + 60, true) : 0;
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onCamera?.({ pos, tgt, up, fov, persp, viewWidth, dofEnabled, dofFocusDistance, dofFocalLength, dofBokehScale });
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.EndFrame: {
                assertSize('EndFrame', commandSize, 4);
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onEndFrame?.(frameId);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateLight: {
                assertSize('UpdateLight', commandSize, 152);
                let o = payloadOffset;
                const handle = view.getUint32(o, true); o += 4;
                const matrix = new Float32Array(buffer, o, 16); o += 64;
                const visible = view.getUint32(o, true) !== 0; o += 4;
                const lightType = view.getUint32(o, true); o += 4;
                const color = [view.getFloat32(o, true), view.getFloat32(o+4, true), view.getFloat32(o+8, true)]; o += 12;
                const intensity = view.getFloat32(o, true); o += 4;
                const distance = view.getFloat32(o, true); o += 4;
                const decay = view.getFloat32(o, true); o += 4;
                const angle = view.getFloat32(o, true); o += 4;
                const penumbra = view.getFloat32(o, true); o += 4;
                const width = view.getFloat32(o, true); o += 4;
                const height = view.getFloat32(o, true); o += 4;
                const groundColor = [view.getFloat32(o, true), view.getFloat32(o+4, true), view.getFloat32(o+8, true)]; o += 12;
                const castShadow = view.getUint32(o, true) !== 0; o += 4;
                const shadowBias = view.getFloat32(o, true); o += 4;
                const shadowRadius = view.getFloat32(o, true); o += 4;
                const shadowMapSize = view.getUint32(o, true); o += 4;
                const volContrib = view.getFloat32(o, true);
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onLight?.(handle, {
                    matrix, visible, type: lightType,
                    color, intensity, distance, decay, angle, penumbra,
                    width, height, groundColor,
                    castShadow, shadowBias, shadowRadius, shadowMapSize, volContrib,
                });
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateSplat: {
                assertSize('UpdateSplat', commandSize, 76);
                const handle = view.getUint32(payloadOffset, true);
                const matrix = new Float32Array(buffer, payloadOffset + 4, 16);
                const visible = view.getUint32(payloadOffset + 68, true) !== 0;
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onSplat?.(handle, matrix, visible);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateAudio: {
                assertSize('UpdateAudio', commandSize, 76);
                const handle = view.getUint32(payloadOffset, true);
                const matrix = new Float32Array(buffer, payloadOffset + 4, 16);
                const visible = view.getUint32(payloadOffset + 68, true) !== 0;
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onAudio?.(handle, matrix, visible);
                applyMs += performance.now() - applyStart;
                break;
            }
            default:
                throw new Error(`Unknown delta command type: ${type}`);
        }

        offset += commandSize;
        if (offset > buffer.byteLength) {
            throw new Error('Delta frame overflow while decoding');
        }
    }

    return {
        frameId,
        commandCount,
        bytes: buffer.byteLength,
        decodeMs,
        applyMs,
    };
}
