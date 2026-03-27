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
                assertSize('UpdateCamera', commandSize, 48);
                const pos = new Float32Array(buffer, payloadOffset, 3);
                const tgt = new Float32Array(buffer, payloadOffset + 12, 3);
                const up = new Float32Array(buffer, payloadOffset + 24, 3);
                const fov = view.getFloat32(payloadOffset + 36, true);
                const persp = view.getUint32(payloadOffset + 40, true) !== 0;
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onCamera?.({ pos, tgt, up, fov, persp });
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
