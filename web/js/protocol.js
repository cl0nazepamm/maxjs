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
    // 9 retired (was UpdateSplat) — do not reuse
    UpdateAudio: 10,
    UpdateTime: 11,
    UpdateGLTF: 12,
    UpdateWebApp: 13,
});

const FRAME_HEADER_SIZE = 16;
const COMMAND_HEADER_SIZE = 4;
const COMMAND_SIZES = Object.freeze({
    [COMMAND_TYPES.BeginFrame]: [8],
    [COMMAND_TYPES.UpdateTransform]: [72],
    [COMMAND_TYPES.UpdateMaterialScalar]: [32],
    [COMMAND_TYPES.UpdateSelection]: [12],
    [COMMAND_TYPES.UpdateVisibility]: [12],
    // v1 originally shipped without the four DOF fields (52 bytes total).
    // Keep that exact legacy shape readable; reject every other size.
    [COMMAND_TYPES.UpdateCamera]: [52, 68],
    [COMMAND_TYPES.EndFrame]: [4],
    [COMMAND_TYPES.UpdateLight]: [152],
    [COMMAND_TYPES.UpdateAudio]: [76],
    [COMMAND_TYPES.UpdateTime]: [16],
    [COMMAND_TYPES.UpdateGLTF]: [76],
    [COMMAND_TYPES.UpdateWebApp]: [76],
});

function assertSize(type, actual, expected) {
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(actual)) {
        throw new Error(`Unexpected command size for ${type}: ${actual} (expected ${allowed.join(' or ')})`);
    }
}

function commandName(type) {
    for (const [name, value] of Object.entries(COMMAND_TYPES)) {
        if (value === type) return name;
    }
    return `opcode ${type}`;
}

function readBoolU32(view, offset, label) {
    const value = view.getUint32(offset, true);
    if (value !== 0 && value !== 1) {
        throw new Error(`Invalid ${label} boolean value: ${value}`);
    }
    return value === 1;
}

function validateCommandPayload(view, type, payloadOffset, commandSize, frameId) {
    switch (type) {
        case COMMAND_TYPES.BeginFrame: {
            const beginFrameId = view.getUint32(payloadOffset, true);
            if (beginFrameId !== frameId) {
                throw new Error(`BeginFrame id ${beginFrameId} does not match frame header ${frameId}`);
            }
            break;
        }
        case COMMAND_TYPES.UpdateSelection:
            readBoolU32(view, payloadOffset + 4, 'UpdateSelection.selected');
            break;
        case COMMAND_TYPES.UpdateVisibility:
            readBoolU32(view, payloadOffset + 4, 'UpdateVisibility.visible');
            break;
        case COMMAND_TYPES.UpdateCamera:
            readBoolU32(view, payloadOffset + 40, 'UpdateCamera.perspective');
            if (commandSize === 68) {
                readBoolU32(view, payloadOffset + 48, 'UpdateCamera.dofEnabled');
            }
            break;
        case COMMAND_TYPES.UpdateLight:
            readBoolU32(view, payloadOffset + 68, 'UpdateLight.visible');
            readBoolU32(view, payloadOffset + 128, 'UpdateLight.castShadow');
            break;
        case COMMAND_TYPES.UpdateAudio:
            readBoolU32(view, payloadOffset + 68, 'UpdateAudio.visible');
            break;
        case COMMAND_TYPES.UpdateTime: {
            const stateFlags = view.getUint8(payloadOffset + 8);
            if ((stateFlags & 0xfe) !== 0) {
                throw new Error(`Unsupported UpdateTime flags: 0x${stateFlags.toString(16)}`);
            }
            if (view.getUint8(payloadOffset + 9) !== 0 ||
                view.getUint8(payloadOffset + 10) !== 0 ||
                view.getUint8(payloadOffset + 11) !== 0) {
                throw new Error('UpdateTime padding must be zero');
            }
            break;
        }
        case COMMAND_TYPES.UpdateGLTF:
            readBoolU32(view, payloadOffset + 68, 'UpdateGLTF.visible');
            break;
        case COMMAND_TYPES.UpdateWebApp:
            readBoolU32(view, payloadOffset + 68, 'UpdateWebApp.visible');
            break;
        default:
            break;
    }
}

function preflightDeltaFrame(view, commandCount, frameId) {
    const byteLength = view.byteLength;
    const maxCommandCount = Math.floor((byteLength - FRAME_HEADER_SIZE) / COMMAND_HEADER_SIZE);
    if (commandCount > maxCommandCount) {
        throw new Error(`Delta frame command count ${commandCount} exceeds available bytes`);
    }

    let offset = FRAME_HEADER_SIZE;
    for (let i = 0; i < commandCount; i++) {
        if (offset > byteLength - COMMAND_HEADER_SIZE) {
            throw new Error(`Truncated delta command header at index ${i}`);
        }
        const type = view.getUint16(offset, true);
        const commandSize = view.getUint16(offset + 2, true);
        const expectedSizes = COMMAND_SIZES[type];
        if (!expectedSizes) {
            throw new Error(`Unknown delta command type: ${type}`);
        }
        assertSize(commandName(type), commandSize, expectedSizes);
        if (commandSize < COMMAND_HEADER_SIZE || commandSize > byteLength - offset) {
            throw new Error(`Delta command ${i} (${commandName(type)}) exceeds frame bounds`);
        }
        validateCommandPayload(view, type, offset + COMMAND_HEADER_SIZE, commandSize, frameId);
        offset += commandSize;
    }
    if (offset !== byteLength) {
        throw new Error(`Delta frame length mismatch: decoded ${offset} of ${byteLength} bytes`);
    }
}

export function applyDeltaFrame(buffer, handlers = {}) {
    let view;
    try {
        view = new DataView(buffer);
    } catch {
        throw new TypeError('Delta frame must be an ArrayBuffer or SharedArrayBuffer');
    }
    if (view.byteLength < FRAME_HEADER_SIZE) {
        throw new Error(`Truncated delta frame header: ${view.byteLength} < ${FRAME_HEADER_SIZE}`);
    }
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

    const reserved = view.getUint16(offset, true);
    offset += 2;
    if (reserved !== 0) {
        throw new Error(`Unsupported delta frame flags: 0x${reserved.toString(16)}`);
    }
    const frameId = view.getUint32(offset, true);
    offset += 4;
    const commandCount = view.getUint32(offset, true);
    offset += 4;

    // Validate the complete frame before invoking a handler. A malformed tail
    // must never leave the live scene half-applied.
    preflightDeltaFrame(view, commandCount, frameId);

    let decodeMs = 0;
    let applyMs = 0;

    for (let i = 0; i < commandCount; i++) {
        const type = view.getUint16(offset, true);
        const commandSize = view.getUint16(offset + 2, true);
        const payloadOffset = offset + COMMAND_HEADER_SIZE;

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
                const selected = readBoolU32(view, payloadOffset + 4, 'UpdateSelection.selected');
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onSelection?.(nodeHandle, selected);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateVisibility: {
                assertSize('UpdateVisibility', commandSize, 12);
                const nodeHandle = view.getUint32(payloadOffset, true);
                const visible = readBoolU32(view, payloadOffset + 4, 'UpdateVisibility.visible');
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onVisibility?.(nodeHandle, visible);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateCamera: {
                assertSize('UpdateCamera', commandSize, [52, 68]);
                const pos = new Float32Array(buffer, payloadOffset, 3);
                const tgt = new Float32Array(buffer, payloadOffset + 12, 3);
                const up = new Float32Array(buffer, payloadOffset + 24, 3);
                const fov = view.getFloat32(payloadOffset + 36, true);
                const persp = readBoolU32(view, payloadOffset + 40, 'UpdateCamera.perspective');
                const viewWidth = view.getFloat32(payloadOffset + 44, true);
                const hasDof = commandSize === 68;
                const dofEnabled = hasDof
                    ? readBoolU32(view, payloadOffset + 48, 'UpdateCamera.dofEnabled')
                    : undefined;
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
                const visible = readBoolU32(view, o, 'UpdateLight.visible'); o += 4;
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
                const castShadow = readBoolU32(view, o, 'UpdateLight.castShadow'); o += 4;
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
            case COMMAND_TYPES.UpdateAudio: {
                assertSize('UpdateAudio', commandSize, 76);
                const handle = view.getUint32(payloadOffset, true);
                const matrix = new Float32Array(buffer, payloadOffset + 4, 16);
                const visible = readBoolU32(view, payloadOffset + 68, 'UpdateAudio.visible');
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onAudio?.(handle, matrix, visible);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateTime: {
                // 4 (ticks i32) + 4 (tpf i32) + 1 (flags u8) + 3 pad = 12 payload
                assertSize('UpdateTime', commandSize, 16);
                const ticks = view.getInt32(payloadOffset, true);
                const tpf = view.getInt32(payloadOffset + 4, true);
                const stateFlags = view.getUint8(payloadOffset + 8);
                if ((stateFlags & 0xfe) !== 0) {
                    throw new Error(`Unsupported UpdateTime flags: 0x${stateFlags.toString(16)}`);
                }
                if (view.getUint8(payloadOffset + 9) !== 0 ||
                    view.getUint8(payloadOffset + 10) !== 0 ||
                    view.getUint8(payloadOffset + 11) !== 0) {
                    throw new Error('UpdateTime padding must be zero');
                }
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onTime?.({ ticks, tpf, stateFlags });
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateGLTF: {
                assertSize('UpdateGLTF', commandSize, 76);
                const handle = view.getUint32(payloadOffset, true);
                const matrix = new Float32Array(buffer, payloadOffset + 4, 16);
                const visible = readBoolU32(view, payloadOffset + 68, 'UpdateGLTF.visible');
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onGLTF?.(handle, matrix, visible);
                applyMs += performance.now() - applyStart;
                break;
            }
            case COMMAND_TYPES.UpdateWebApp: {
                assertSize('UpdateWebApp', commandSize, 76);
                const handle = view.getUint32(payloadOffset, true);
                const matrix = new Float32Array(buffer, payloadOffset + 4, 16);
                const visible = readBoolU32(view, payloadOffset + 68, 'UpdateWebApp.visible');
                decodeMs += performance.now() - decodeStart;
                const applyStart = performance.now();
                handlers.onWebApp?.(handle, matrix, visible);
                applyMs += performance.now() - applyStart;
                break;
            }
            default:
                throw new Error(`Unknown delta command type: ${type}`);
        }

        offset += commandSize;
    }

    return {
        frameId,
        commandCount,
        bytes: buffer.byteLength,
        decodeMs,
        applyMs,
    };
}
