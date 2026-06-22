# serialize.py — DCC-agnostic: neutral scene IR → (snapshot.json dict, scene.bin bytes).
#
# This module knows NOTHING about Blender or Max. It only knows the max.js
# snapshot format (via contract.py). Any producer that can build the neutral IR
# below drives the shared web/ runtime. extract_blender.py is the Blender
# producer; a Max producer or any other DCC would be a sibling.
#
# Neutral IR
# ----------
# scene = {
#   "nodes":   [Node, ...],
#   "lights":  [LightIR, ...],          # already in max.js light-record shape
#   "camera":  CameraIR | None,
#   # optional viewer hints:
#   "rendererBackend": "WebGL"|"WebGPU", "toneMapping": str, "exposure": float,
#   "background": int, "fps": int,
# }
# Node = {
#   "handle": int, "name": str, "parent": int|None,
#   "matrix": [16 floats, column-major, Z-up world],
#   "visible": bool, "selected": bool, "helper": bool,
#   "material": {MaxJSPBR} | None,      # deduped here → top-level materials[] + matRef
#   "materials": [{MaxJSPBR}|None, ...] # optional multi-material list → matRefs
#   "mesh": Mesh | None,                # None ⇒ helper (transform-only)
# }
# Mesh = {
#   "positions": seq(3V) float,         # object/local space
#   "indices":   seq(3T) int,
#   "normals":   seq(3V) float | None,
#   "uvs":       seq(2V) float | None,
#   "uv2s":      seq(2V) float | None,
#   "groups":    [[start, count, materialIndex], ...] | None,
# }

import json

try:
    from . import contract
except ImportError:  # allow `import serialize` in standalone tests
    import contract


DEFAULT_PROPS = {
    "opacity": 1.0, "rend": 1, "cshadow": 1, "rshadow": 1,
    "visCam": 1, "visRefl": 1, "bcull": 0,
}

DEFAULT_MATERIAL = {
    "name": "default", "model": "MeshStandardMaterial",
    "color": [0.8, 0.8, 0.8], "rough": 0.5, "metal": 0.0,
}


def _numpy():
    return contract._numpy()


def _align(buf, alignment):
    pad = (-len(buf)) % alignment
    if pad:
        buf.extend(b"\x00" * pad)


def _len(seq):
    return int(seq.size) if hasattr(seq, "size") else len(seq)


def _minmax(seq):
    n = _len(seq)
    if n == 0:
        return 0.0, 0.0
    np = _numpy()
    if np is not None:
        a = np.asarray(seq)
        return float(a.min()), float(a.max())
    return float(min(seq)), float(max(seq))


def _append_geo(buf, mesh, *, adaptive=True):
    """Append a node's geometry to the shared buffer; return its `geo` descriptor.

    Block order v→i→uv→uv2→n mirrors the native producers. Static snapshot
    export uses the adaptive scene.bin contract; live IPR fullsync keeps the
    Max viewer's float32/int32 channel layout so geo_fast can patch it in place.
    """
    pos = mesh["positions"]
    idx = mesh["indices"]
    nrm = mesh.get("normals")
    uv = mesh.get("uvs")
    uv2 = mesh.get("uv2s")
    geo = {}

    # positions — always f32, align 4
    _align(buf, 4)
    geo["vOff"] = len(buf)
    geo["vN"] = _len(pos)
    buf += contract.pack_f32(pos)

    # indices — snapshot export may pack to u16; live IPR fullsync stays int32.
    imin, imax = _minmax(idx)
    itype = contract.index_type(int(imin), int(imax), _len(idx)) if adaptive else ""
    _align(buf, contract.ALIGN["u16"] if itype == "u16" else contract.ALIGN["i32"])
    geo["iOff"] = len(buf)
    geo["iN"] = _len(idx)
    if itype == "u16":
        geo["iType"] = "u16"
        buf += contract.pack_u16(idx)
    else:
        buf += contract.pack_i32(idx)

    # uvs — snapshot export may pack to u16n; live IPR fullsync stays f32.
    if uv is not None and _len(uv):
        umin, umax = _minmax(uv)
        utype = contract.uv_type(umin, umax, _len(uv)) if adaptive else ""
        _align(buf, contract.ALIGN["u16n"] if utype == "u16n" else contract.ALIGN["f32"])
        geo["uvOff"] = len(buf)
        geo["uvN"] = _len(uv)
        if utype == "u16n":
            geo["uvType"] = "u16n"
            buf += contract.pack_u16n(uv)
        else:
            buf += contract.pack_f32(uv)

    # uv2 — same packing choice as the first UV channel.
    if uv2 is not None and _len(uv2):
        umin, umax = _minmax(uv2)
        utype = contract.uv_type(umin, umax, _len(uv2)) if adaptive else ""
        _align(buf, contract.ALIGN["u16n"] if utype == "u16n" else contract.ALIGN["f32"])
        geo["uv2Off"] = len(buf)
        geo["uv2N"] = _len(uv2)
        if utype == "u16n":
            geo["uv2Type"] = "u16n"
            buf += contract.pack_u16n(uv2)
        else:
            buf += contract.pack_f32(uv2)

    # normals — snapshot export may pack to i16n; live IPR fullsync stays f32.
    if nrm is not None and _len(nrm):
        nmin, nmax = _minmax(nrm)
        ntype = contract.normal_type(nmin, nmax, _len(nrm)) if adaptive else ""
        _align(buf, contract.ALIGN["i16n"] if ntype == "i16n" else contract.ALIGN["f32"])
        geo["nOff"] = len(buf)
        geo["nN"] = _len(nrm)
        if ntype == "i16n":
            geo["nType"] = "i16n"
            buf += contract.pack_i16n(nrm)
        else:
            buf += contract.pack_f32(nrm)

    return geo


def build_geo_fast_update(handle, mesh, *, materials=None, jsmod=False, spline=False):
    """Build the Max live `geo_fast` shared-buffer packet for one changed mesh.

    This is the binary path from src/maxjs_panel_sync.inl: float32 vertices,
    int32 indices, float32 UVs, float32 normals, plus optional material groups.
    """
    buf = bytearray()
    meta = {"type": "geo_fast", "h": int(handle), "jsmod": bool(jsmod)}
    if spline:
        meta["spline"] = True

    pos = mesh["positions"]
    idx = mesh["indices"]
    uv = mesh.get("uvs")
    nrm = mesh.get("normals")

    _align(buf, 4)
    meta["vOff"] = len(buf)
    meta["vN"] = _len(pos)
    buf += contract.pack_f32(pos)

    _align(buf, 4)
    meta["iOff"] = len(buf)
    meta["iN"] = _len(idx)
    buf += contract.pack_i32(idx)

    if uv is not None and _len(uv):
        _align(buf, 4)
        meta["uvOff"] = len(buf)
        meta["uvN"] = _len(uv)
        buf += contract.pack_f32(uv)

    if nrm is not None and _len(nrm):
        _align(buf, 4)
        meta["nOff"] = len(buf)
        meta["nN"] = _len(nrm)
        buf += contract.pack_f32(nrm)

    groups = mesh.get("groups") or []
    if groups:
        meta["groups"] = [[int(a), int(b), int(c)] for a, b, c in groups]
        if materials:
            meta["mats"] = [mat or DEFAULT_MATERIAL for mat in materials]

    if len(buf) == 0:
        buf = bytearray(4)
    return meta, bytes(buf)


class _MaterialLibrary:
    def __init__(self):
        self.entries = []
        self._cache = {}

    @staticmethod
    def _canonical_json(mat, *, key=False):
        mat = mat or DEFAULT_MATERIAL
        if key:
            mat = dict(mat)
            mat.pop("name", None)
        return json.dumps(mat, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    def intern(self, mat):
        mat = mat or DEFAULT_MATERIAL
        key = self._canonical_json(mat, key=True)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        mid = len(self.entries) + 1
        self.entries.append({"id": mid, "hash": contract.hash_fnv1a(key), "mat": mat})
        self._cache[key] = mid
        return mid


def _default_camera():
    return {"pos": [12.0, -16.0, 9.0], "tgt": [0.0, 0.0, 1.0], "up": [0.0, 0.0, 1.0],
            "fov": 45.0, "persp": True}


def _snapshot_ui(scene, camera):
    return {
        "rendererBackend": scene.get("rendererBackend", "WebGL"),
        "toneMapping": scene.get("toneMapping", "AgX"),
        "exposure": float(scene.get("exposure", 1.0)),
        "aaMode": "msaa",
        "background": int(scene.get("background", 0)),
        "envVisible": False,
        "camLock": False,
        "lightMode": False,
        "lightProbeEnabled": True,
        "camera": {
            "position": camera["pos"], "target": camera["tgt"], "up": camera["up"],
            "fov": camera["fov"], "perspective": bool(camera.get("persp", True)),
            "near": 0.1, "far": 100000.0, "viewWidth": float(camera.get("viewWidth", 0.0)),
        },
        "cameraClip": {"near": 0.1, "far": 100000.0},
        "hdri": {"enabled": False},
        "fx": {},
        "bake": {"enabled": False},
        "performance": {"renderScale": 1.0, "postFxScale": 1.0, "splatsEnabled": True},
        "studio": {},
        "timeline": {"startFrame": 0, "endFrame": 0, "fps": int(scene.get("fps", 24)),
                     "defaultPlaying": False},
    }


def _runtime_features(scene, snapshot):
    backend = str(scene.get("rendererBackend", "WebGL")).lower()
    renderer_pref = "webgpu" if backend == "webgpu" else "webgl"
    mesh_nodes = sum(1 for nd in snapshot.get("nodes", []) if nd.get("geo"))
    return {
        "version": 1,
        "renderer_pref": renderer_pref,
        "audio": False,
        "splats": False,
        "html_textures": False,
        "volumes": False,
        "physics": False,
        "gltf": False,
        "animations": False,
        "environment": False,
        "hdri": False,
        "sky": False,
        "geospatial_sky": False,
        "binary_instances": False,
        "post_fx": [],
        "three_addons": ["OrbitControls"],
        "snapshotUi": True,
        "runtimeScene": False,
        "project": False,
        "inlines": False,
        "stats": {
            "meshes": mesh_nodes,
            "materials": len(snapshot.get("materials", [])),
            "skinnedMeshes": 0,
            "morphTargets": 0,
            "vertexColorAttrs": 0,
            "lights": len(snapshot.get("lights", [])),
            "instanceGroups": 0,
        },
    }


def build_snapshot(scene, *, adaptive_geometry=True):
    """Return (snapshot_dict, scene_bin_bytes) from a neutral scene IR."""
    buf = bytearray()
    lib = _MaterialLibrary()
    nodes_json = []

    for nd in scene.get("nodes", []):
        j = {"h": int(nd["handle"]), "n": nd.get("name", ""),
             "s": 1 if nd.get("selected") else 0}
        parent = nd.get("parent")
        if parent:
            j["p"] = int(parent)

        mesh = nd.get("mesh")
        if nd.get("helper") or mesh is None:
            j["helper"] = True
            j["vis"] = 1 if nd.get("visible", True) else 0
            j["t"] = [float(x) for x in nd["matrix"]]
            nodes_json.append(j)
            continue

        j["props"] = dict(DEFAULT_PROPS)
        j["vis"] = 1 if nd.get("visible", True) else 0
        j["t"] = [float(x) for x in nd["matrix"]]
        j["geo"] = _append_geo(buf, mesh, adaptive=adaptive_geometry)
        groups = mesh.get("groups") or []
        materials = nd.get("materials") or []
        if groups and materials:
            j["groups"] = [[int(a), int(b), int(c)] for a, b, c in groups]
            j["matRefs"] = [lib.intern(mat) for mat in materials]
        else:
            j["matRef"] = lib.intern(nd.get("material"))
        nodes_json.append(j)

    if len(buf) == 0:
        buf = bytearray(4)  # matches C++ minimum (totalBytes = 4)

    camera = scene.get("camera") or _default_camera()
    snap = {
        "type": contract.SNAPSHOT_TYPE,
        "frame": contract.SNAPSHOT_FRAME,
        "bin": contract.BIN_NAME,
        "stats": {"producerBytes": len(buf)},
        "nodes": nodes_json,
        "materials": lib.entries,
        "camera": {
            "pos": camera["pos"], "tgt": camera["tgt"], "up": camera["up"],
            "fov": camera["fov"], "persp": bool(camera.get("persp", True)),
            "dofEnabled": False, "dofFocusDistance": 0.0,
            "dofFocalLength": 0.0, "dofBokehScale": 0.0,
        },
        "env": {"enabled": False, "type": "none"},
        "fog": {"active": False, "type": "none"},
        "sceneCameras": scene.get("sceneCameras", []),
        "lockedCamera": int(scene.get("lockedCamera", 0) or 0),
        "lights": scene.get("lights", []),
        "splats": [], "audios": [], "gltfs": [], "webapps": [],
        "snapshotUi": _snapshot_ui(scene, camera),
    }
    snap["runtimeFeatures"] = _runtime_features(scene, snap)
    return snap, bytes(buf)


def write_snapshot(out_dir, scene, *, adaptive_geometry=True):
    """Build and write snapshot.json + scene.bin into out_dir. Returns a stats dict."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    snap, binary = build_snapshot(scene, adaptive_geometry=adaptive_geometry)
    with open(os.path.join(out_dir, contract.BIN_NAME), "wb") as f:
        f.write(binary)
    with open(os.path.join(out_dir, "snapshot.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f, separators=(",", ":"))
    return {
        "out_dir": out_dir,
        "nodes": len(snap["nodes"]),
        "materials": len(snap["materials"]),
        "lights": len(snap["lights"]),
        "bin_bytes": len(binary),
    }
