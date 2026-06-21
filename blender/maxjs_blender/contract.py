# contract.py — the max.js format contract, mirrored on the Blender side.
#
# THIS FILE IS THE TRANSLATION-LAYER SPINE. It encodes the exact, authoritative
# byte/JSON rules that max.js's C++ producer uses, so a non-Max producer
# (Blender) emits output the SHARED web/ runtime accepts unchanged.
#
# Single sources of truth in the max.js repo (keep these references current):
#   - scene.bin adaptive element types + alignment:
#       src/maxjs_main.cpp  (CanPackIndicesU16 / CanPackUvsU16N / CanPackNormalsI16N,
#                            ReserveBinary*Range, CopyBinary*, AlignBinarySize)
#   - snapshot.json node/material/geo schema:
#       src/maxjs_panel_snapshot_export.inl, src/maxjs_panel_fullsync.inl
#   - JS consumers (must agree):
#       web/js/scene_binary.js, web/js/scene_applier.js,
#       web/js/material_contract.js, web/js/material_builder.js, web/js/scene_lights.js
#   - delta wire protocol (live IPR, phase 2):
#       src/sync_protocol.h  <->  web/js/protocol.js
#
# Pure module: NO bpy, NO numpy required to import. The packing helpers use
# numpy when present (Blender always bundles it) and fall back to the stdlib
# `array` module so this file stays unit-testable outside Blender.

import math
import struct
from array import array

# ─────────────────────────────────────────────────────────────────────────
# Snapshot identity
# ─────────────────────────────────────────────────────────────────────────
SNAPSHOT_TYPE = "scene_bin"
SNAPSHOT_FRAME = 1
BIN_NAME = "scene.bin"

# Light type ids — must match the switch in web/js/scene_lights.js.
LIGHT_DIRECTIONAL = 0
LIGHT_POINT = 1
LIGHT_SPOT = 2
LIGHT_RECT = 3
LIGHT_DISC = 4
LIGHT_HEMI = 5

# ─────────────────────────────────────────────────────────────────────────
# Photometric conversion: Blender radiometric watts → the units scene_lights.js
# feeds straight into three.js (`light.intensity = ld.intensity`).
#
# Verified against the live runtime (its own default rig): DirectionalLight /
# Hemisphere / Ambient intensity is a PLAIN multiplier here (the runtime's
# defaults sit at ~0.4–2.5), NOT lux — so a Blender sun maps to its raw energy.
# Point/Spot intensity IS candela with inverse-square decay (the Max exporter
# emits ~10^5 for spots), so those get the 683 lm/W → candela conversion.
# Blender Sun "Strength" is W/m²; Point/Spot/Area are radiometric W.
# ─────────────────────────────────────────────────────────────────────────
LUMENS_PER_WATT = 683.0


def sun_intensity(energy_w_per_m2):
    # DirectionalLight.intensity is a plain multiplier in this runtime.
    return float(energy_w_per_m2)


def point_intensity(power_w):
    return float(power_w) * LUMENS_PER_WATT / (4.0 * math.pi)


def spot_intensity(power_w):
    # three.js treats SpotLight.intensity as candela at the cone axis, same as a point.
    return point_intensity(power_w)


def rect_intensity(power_w, width, height):
    area = max(1e-6, float(width) * float(height))
    return float(power_w) * LUMENS_PER_WATT / (area * math.pi)


# ─────────────────────────────────────────────────────────────────────────
# scene.bin element-type selection — EXACT mirror of src/maxjs_main.cpp.
# Empty string means "default" (positions f32, indices int32, uvs/normals f32)
# and the producer omits the *Type key, matching the C++ which only writes the
# key when a packed form is chosen.
# ─────────────────────────────────────────────────────────────────────────

# Byte alignment per element type. AlignBinarySize(byteSize, alignof(T)).
ALIGN = {
    "f32": 4, "i32": 4, "u32": 4,
    "u16": 2, "u16n": 2, "i16n": 2,
    "u8": 1, "u8n": 1,
}
ITEMSIZE = dict(ALIGN)  # element byte size happens to equal alignment here


def index_type(min_index, max_index, count):
    """CanPackIndicesU16: non-empty AND every index in [0, 65535]."""
    if count > 0 and min_index >= 0 and max_index <= 65535:
        return "u16"
    return ""  # → int32 (key omitted)


def uv_type(min_v, max_v, count):
    """CanPackUvsU16N: non-empty, even length, every value in [-1e-5, 1+1e-5]."""
    if count > 0 and count % 2 == 0 and min_v >= -0.00001 and max_v <= 1.00001:
        return "u16n"
    return ""  # → f32


def normal_type(min_v, max_v, count):
    """CanPackNormalsI16N: non-empty, len%3==0, every value in [-1.0001, 1.0001]."""
    if count > 0 and count % 3 == 0 and min_v >= -1.0001 and max_v <= 1.0001:
        return "i16n"
    return ""  # → f32


# ─────────────────────────────────────────────────────────────────────────
# Byte packers — numpy-first, stdlib fallback. Output is always little-endian
# (x86/x64; the runtime reads typed-array views which are platform LE).
# ─────────────────────────────────────────────────────────────────────────
def _numpy():
    try:
        import numpy as np
        return np
    except Exception:
        return None


def _round_half_away(np, x):
    # C++ std::lround rounds half away from zero; numpy rint rounds half-to-even.
    return np.sign(x) * np.floor(np.abs(x) + 0.5)


def pack_f32(values):
    np = _numpy()
    if np is not None:
        return np.ascontiguousarray(values, dtype="<f4").tobytes()
    a = array("f", values)
    assert a.itemsize == 4
    if struct.pack("=I", 1) != struct.pack("<I", 1):
        a.byteswap()
    return a.tobytes()


def pack_i32(values):
    np = _numpy()
    if np is not None:
        return np.ascontiguousarray(values, dtype="<i4").tobytes()
    # pick a 4-byte signed typecode
    for code in ("i", "l"):
        a = array(code, [0])
        if a.itemsize == 4:
            a = array(code, values)
            if struct.pack("=I", 1) != struct.pack("<I", 1):
                a.byteswap()
            return a.tobytes()
    raise RuntimeError("no 4-byte int typecode available")


def pack_u16(values):
    np = _numpy()
    if np is not None:
        return np.ascontiguousarray(values, dtype="<u2").tobytes()
    a = array("H", [int(v) & 0xFFFF for v in values])
    assert a.itemsize == 2
    if struct.pack("=I", 1) != struct.pack("<I", 1):
        a.byteswap()
    return a.tobytes()


def pack_u16n(values):
    """clamp(v,0,1) → round(v*65535) → uint16 (CopyBinaryUvs)."""
    np = _numpy()
    if np is not None:
        x = np.clip(np.asarray(values, dtype="f8"), 0.0, 1.0)
        q = np.clip(_round_half_away(np, x * 65535.0), 0, 65535).astype("<u2")
        return q.tobytes()
    out = array("H")
    for v in values:
        v = 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)
        out.append(max(0, min(65535, int(math.floor(v * 65535.0 + 0.5)))))
    if struct.pack("=I", 1) != struct.pack("<I", 1):
        out.byteswap()
    return out.tobytes()


def pack_i16n(values):
    """clamp(v,-1,1) → round(v*32767) → clamp[-32767,32767] → int16 (CopyBinaryNormals)."""
    np = _numpy()
    if np is not None:
        x = np.clip(np.asarray(values, dtype="f8"), -1.0, 1.0)
        q = np.clip(_round_half_away(np, x * 32767.0), -32767, 32767).astype("<i2")
        return q.tobytes()
    out = array("h")
    for v in values:
        v = -1.0 if v < -1.0 else (1.0 if v > 1.0 else v)
        s = -1.0 if v < 0 else 1.0
        out.append(max(-32767, min(32767, int(s * math.floor(abs(v) * 32767.0 + 0.5)))))
    if struct.pack("=I", 1) != struct.pack("<I", 1):
        out.byteswap()
    return out.tobytes()


# ─────────────────────────────────────────────────────────────────────────
# Delta wire protocol conformance (phase 2 — live IPR). Mirrors
# src/sync_protocol.h. The asserts below are tripwires: if max.js changes a
# payload layout and someone updates these sizes without updating the
# producer, the import fails loudly instead of emitting corrupt frames.
# ─────────────────────────────────────────────────────────────────────────
DELTA_FRAME_MAGIC = 0x424A584D  # "MXJB"
DELTA_FRAME_VERSION = 1

COMMAND = {
    "BeginFrame": 1, "UpdateTransform": 2, "UpdateMaterialScalar": 3,
    "UpdateSelection": 4, "UpdateVisibility": 5, "UpdateCamera": 6,
    "EndFrame": 7, "UpdateLight": 8, "UpdateSplat": 9, "UpdateAudio": 10,
    "UpdateTime": 11, "UpdateGLTF": 12, "UpdateWebApp": 13,
}

_WIRE = {"U8": 1, "PadU8": 1, "U16": 2, "U32": 4, "F32": 4,
         "BoolU32": 4, "Vec3": 12, "Mat16": 64}


def _layout(*fields):
    return sum(_WIRE[f] for f in fields)


# These must equal the static_asserts in sync_protocol.h.
LAYOUT = {
    "BeginFrame": _layout("U32"),
    "Transform": _layout("U32", "Mat16"),
    "MaterialScalar": _layout("U32", "Vec3", "F32", "F32", "F32"),
    "Selection": _layout("U32", "BoolU32"),
    "Visibility": _layout("U32", "BoolU32"),
    "Camera": _layout("Vec3", "Vec3", "Vec3", "F32", "BoolU32", "F32",
                      "BoolU32", "F32", "F32", "F32"),
    "Light": _layout("U32", "Mat16", "BoolU32", "U32", "Vec3", "F32", "F32",
                     "F32", "F32", "F32", "F32", "F32", "Vec3", "BoolU32",
                     "F32", "F32", "U32", "F32"),
    "Splat": _layout("U32", "Mat16", "BoolU32"),
    "Time": _layout("U32", "U32", "U8", "PadU8", "PadU8", "PadU8"),
    "EndFrame": 0,
}

assert LAYOUT["BeginFrame"] == 4, LAYOUT
assert LAYOUT["Transform"] == 68, LAYOUT
assert LAYOUT["MaterialScalar"] == 28, LAYOUT
assert LAYOUT["Selection"] == 8 and LAYOUT["Visibility"] == 8, LAYOUT
assert LAYOUT["Camera"] == 64, LAYOUT
assert LAYOUT["Light"] == 148, LAYOUT
assert LAYOUT["Splat"] == 72, LAYOUT
assert LAYOUT["Time"] == 12, LAYOUT
assert LAYOUT["EndFrame"] == 0, LAYOUT


# ─────────────────────────────────────────────────────────────────────────
# DeltaFrameBuilder — byte-identical Python port of src/sync_protocol.cpp.
# This is the live-IPR encoder: the Blender delta pump emits the SAME MXJB
# frames the 3ds Max plugin emits, decoded by the SAME web/js/protocol.js.
# Payload sizes come from LAYOUT above (single source of truth).
# ─────────────────────────────────────────────────────────────────────────
_CMD_HEADER = 4  # u16 type + u16 size


class DeltaFrameBuilder:
    def __init__(self, frame_id):
        self._b = bytearray()
        self._count = 0
        self._frame_id = int(frame_id) & 0xFFFFFFFF
        # Frame header: magic, version, reserved, frameId, commandCount(placeholder)
        self._u32(DELTA_FRAME_MAGIC)
        self._u16(DELTA_FRAME_VERSION)
        self._u16(0)
        self._u32(self._frame_id)
        self._count_off = len(self._b)
        self._u32(0)

    # ── low-level appenders (little-endian, matches x86 memcpy) ──
    def _u16(self, v):
        self._b += struct.pack("<H", int(v) & 0xFFFF)

    def _u32(self, v):
        self._b += struct.pack("<I", int(v) & 0xFFFFFFFF)

    def _i32(self, v):
        self._b += struct.pack("<i", int(v))

    def _f32(self, v):
        self._b += struct.pack("<f", float(v))

    def _begin(self, cmd_name, payload_bytes):
        self._u16(COMMAND[cmd_name])
        self._u16(_CMD_HEADER + payload_bytes)
        self._count += 1

    # ── commands (field order mirrors sync_protocol.cpp exactly) ──
    def begin_frame(self):
        self._begin("BeginFrame", LAYOUT["BeginFrame"])
        self._u32(self._frame_id)

    def update_transform(self, handle, matrix16):
        self._begin("UpdateTransform", LAYOUT["Transform"])
        self._u32(handle)
        for i in range(16):
            self._f32(matrix16[i])

    def update_material_scalar(self, handle, color3, rough, metal, opacity):
        self._begin("UpdateMaterialScalar", LAYOUT["MaterialScalar"])
        self._u32(handle)
        self._f32(color3[0]); self._f32(color3[1]); self._f32(color3[2])
        self._f32(rough); self._f32(metal); self._f32(opacity)

    def update_selection(self, handle, selected):
        self._begin("UpdateSelection", LAYOUT["Selection"])
        self._u32(handle); self._u32(1 if selected else 0)

    def update_visibility(self, handle, visible):
        self._begin("UpdateVisibility", LAYOUT["Visibility"])
        self._u32(handle); self._u32(1 if visible else 0)

    def update_camera(self, pos3, tgt3, up3, fov, persp, view_width=0.0,
                      dof_enabled=False, dof_focus=0.0, dof_focal=0.0, dof_bokeh=0.0):
        self._begin("UpdateCamera", LAYOUT["Camera"])
        for v in pos3: self._f32(v)
        for v in tgt3: self._f32(v)
        for v in up3: self._f32(v)
        self._f32(fov); self._u32(1 if persp else 0); self._f32(view_width)
        self._u32(1 if dof_enabled else 0)
        self._f32(dof_focus); self._f32(dof_focal); self._f32(dof_bokeh)

    def update_light(self, handle, d):
        """d: dict with matrix16, visible, type, color[3], intensity, distance,
        decay, angle, penumbra, width, height, groundColor[3], castShadow,
        shadowBias, shadowRadius, shadowMapSize, volContrib."""
        self._begin("UpdateLight", LAYOUT["Light"])
        self._u32(handle)
        m = d["matrix16"]
        for i in range(16):
            self._f32(m[i])
        self._u32(1 if d.get("visible", True) else 0)
        self._u32(int(d.get("type", 0)))
        c = d.get("color", (1, 1, 1)); self._f32(c[0]); self._f32(c[1]); self._f32(c[2])
        self._f32(d.get("intensity", 1.0))
        self._f32(d.get("distance", 0.0))
        self._f32(d.get("decay", 2.0))
        self._f32(d.get("angle", 0.0))
        self._f32(d.get("penumbra", 0.0))
        self._f32(d.get("width", 0.0))
        self._f32(d.get("height", 0.0))
        g = d.get("groundColor", (0, 0, 0)); self._f32(g[0]); self._f32(g[1]); self._f32(g[2])
        self._u32(1 if d.get("castShadow", False) else 0)
        self._f32(d.get("shadowBias", 0.0))
        self._f32(d.get("shadowRadius", 0.0))
        self._u32(int(d.get("shadowMapSize", 1024)))
        self._f32(d.get("volContrib", 0.0))

    def update_time(self, ticks, tpf, state_flags):
        self._begin("UpdateTime", LAYOUT["Time"])
        self._u32(ticks); self._u32(tpf)
        self._b += struct.pack("<B", int(state_flags) & 0xFF)
        self._b += b"\x00\x00\x00"

    def end_frame(self):
        self._begin("EndFrame", LAYOUT["EndFrame"])
        struct.pack_into("<I", self._b, self._count_off, self._count)

    def command_count(self):
        return self._count

    def bytes(self):
        return bytes(self._b)
