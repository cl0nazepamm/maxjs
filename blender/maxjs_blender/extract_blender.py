# extract_blender.py — Blender depsgraph → neutral scene IR.
#
# THIS IS THE ONLY BLENDER-COUPLED MODULE. It is the Blender analog of max.js's
# src/maxjs_scene_extractors.h + maxjs_geometry_sync.h: it reads the evaluated
# scene and produces the plain dict IR that serialize.py turns into the shared
# snapshot format. To port max.js to another DCC, you reimplement *only* this
# file.
#
# Coordinate basis: Blender is +Z up, right-handed — identical to 3ds Max. The
# web/ runtime keeps the whole scene in Max/Z-up space and applies one −90° X
# rotation at the basis root (web/js/max_basis.js), so Blender data passes
# through with NO per-node axis conversion. Transforms are emitted column-major
# (translation at indices 12/13/14), matching three.js Matrix4.fromArray and
# scene_applier.js (which re-localizes the world matrix against the parent).

import math

import bpy
import mathutils

try:
    from . import contract
except ImportError:
    import contract

_MESHABLE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}


def _matrix16(obj):
    """Object world matrix as a 16-float column-major array (Z-up)."""
    m = obj.matrix_world
    return [m[r][c] for c in range(4) for r in range(4)]


def _visible(obj):
    try:
        return bool(obj.visible_get())
    except Exception:
        return not obj.hide_render


# ─────────────────────────── geometry ────────────────────────────────────
def _extract_mesh(obj, depsgraph):
    import numpy as np

    ev = obj.evaluated_get(depsgraph)
    try:
        me = ev.to_mesh()
    except Exception:
        return None
    if me is None:
        return None
    try:
        me.calc_loop_triangles()
        nv, nl, nt = len(me.vertices), len(me.loops), len(me.loop_triangles)
        if nt == 0 or nv == 0:
            return None

        co = np.empty(nv * 3, "f4"); me.vertices.foreach_get("co", co)
        tri_v = np.empty(nt * 3, "i4"); me.loop_triangles.foreach_get("vertices", tri_v)
        tri_l = np.empty(nt * 3, "i4"); me.loop_triangles.foreach_get("loops", tri_l)

        # split (corner) normals — Blender 4.1+ exposes mesh.corner_normals.
        cn = None
        try:
            tmp = np.empty(nl * 3, "f4")
            me.corner_normals.foreach_get("vector", tmp)
            cn = tmp
        except Exception:
            try:
                me.calc_normals_split()
                tmp = np.empty(nl * 3, "f4")
                me.loops.foreach_get("normal", tmp)
                cn = tmp
            except Exception:
                cn = None  # let three.js computeVertexNormals()

        uvl = me.uv_layers.active
        uvf = None
        if uvl is not None and len(uvl.data) == nl:
            uvf = np.empty(nl * 2, "f4"); uvl.data.foreach_get("uv", uvf)

        # Per-corner attribute rows, then dedup by exact equality so smooth-
        # shared corners collapse while hard edges / uv seams split.
        cols = [co.reshape(nv, 3)[tri_v]]
        if cn is not None:
            cols.append(cn.reshape(nl, 3)[tri_l])
        if uvf is not None:
            cols.append(uvf.reshape(nl, 2)[tri_l])
        allc = np.concatenate(cols, axis=1)
        uniq, inverse = np.unique(allc, axis=0, return_inverse=True)
        inverse = inverse.reshape(-1).astype("i4")

        off = 0
        positions = np.ascontiguousarray(uniq[:, off:off + 3]).reshape(-1); off += 3
        normals = None
        if cn is not None:
            normals = np.ascontiguousarray(uniq[:, off:off + 3]).reshape(-1); off += 3
        uvs = None
        if uvf is not None:
            uvs = np.ascontiguousarray(uniq[:, off:off + 2]).reshape(-1); off += 2

        return {"positions": positions, "indices": inverse,
                "normals": normals, "uvs": uvs}
    finally:
        ev.to_mesh_clear()


# ─────────────────────────── materials ───────────────────────────────────
def _find_principled(mat):
    if not mat or not mat.use_nodes or not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def _inp(node, names, default):
    for nm in names:
        try:
            return node.inputs[nm].default_value
        except (KeyError, TypeError):
            continue
    return default


def _material_to_pbr(mat):
    if mat is None:
        return None
    node = _find_principled(mat)
    side = 0 if getattr(mat, "use_backface_culling", False) else 1
    if node is None:
        col = list(getattr(mat, "diffuse_color", (0.8, 0.8, 0.8, 1.0)))[:3]
        return {"name": mat.name, "model": "MeshStandardMaterial",
                "color": [float(c) for c in col],
                "rough": float(getattr(mat, "roughness", 0.5)),
                "metal": float(getattr(mat, "metallic", 0.0)), "side": side}

    base = _inp(node, ["Base Color"], (0.8, 0.8, 0.8, 1.0))
    emis = _inp(node, ["Emission Color", "Emission"], (0.0, 0.0, 0.0, 1.0))
    estr = float(_inp(node, ["Emission Strength"], 0.0))
    trans = float(_inp(node, ["Transmission Weight", "Transmission"], 0.0))
    alpha = float(_inp(node, ["Alpha"], 1.0))

    pbr = {
        "name": mat.name, "model": "MeshPhysicalMaterial",
        "color": [float(base[0]), float(base[1]), float(base[2])],
        "rough": float(_inp(node, ["Roughness"], 0.5)),
        "metal": float(_inp(node, ["Metallic"], 0.0)),
        "ior": float(_inp(node, ["IOR"], 1.5)),
        "side": side,
    }
    if trans > 0.0:
        pbr["transmission"] = trans
    if estr > 0.0 and any(float(c) > 0.0 for c in emis[:3]):
        pbr["em"] = [float(emis[0]), float(emis[1]), float(emis[2])]
        pbr["emI"] = estr
    if alpha < 0.999:
        pbr["opacity"] = alpha
    return pbr


# ─────────────────────────── lights ──────────────────────────────────────
def _light_to_ir(obj, handle):
    L = obj.data
    m = obj.matrix_world
    fwd = (m.to_3x3() @ mathutils.Vector((0, 0, -1))).normalized()
    rec = {
        "h": handle, "name": obj.name,
        "pos": [m.translation.x, m.translation.y, m.translation.z],
        "dir": [fwd.x, fwd.y, fwd.z],
        "color": [float(L.color[0]), float(L.color[1]), float(L.color[2])],
        "distance": 0.0, "decay": 2.0,
        "angle": 0.0, "penumbra": 0.0, "width": 0.0, "height": 0.0,
        "castShadow": bool(getattr(L, "use_shadow", True)),
        # three.js shadow.bias wants a small NEGATIVE value to kill self-shadow
        # acne; a positive bias (what we naively had) striped every surface.
        "shadowBias": -0.0005, "shadowRadius": 4.0, "shadowMapSize": 2048,
        "volContrib": 0.0,
    }
    if L.type == "SUN":
        rec["type"] = contract.LIGHT_DIRECTIONAL
        rec["intensity"] = contract.sun_intensity(L.energy)
    elif L.type == "POINT":
        rec["type"] = contract.LIGHT_POINT
        rec["intensity"] = contract.point_intensity(L.energy)
    elif L.type == "SPOT":
        rec["type"] = contract.LIGHT_SPOT
        rec["intensity"] = contract.spot_intensity(L.energy)
        rec["angle"] = float(L.spot_size) / 2.0
        rec["penumbra"] = float(L.spot_blend)
    elif L.type == "AREA":
        rec["type"] = contract.LIGHT_RECT
        w = float(getattr(L, "size", 1.0))
        h = float(getattr(L, "size_y", w)) if L.shape in {"RECTANGLE", "ELLIPSE"} else w
        rec["width"], rec["height"] = w, h
        rec["intensity"] = contract.rect_intensity(L.energy, w, h)
    else:
        return None
    if getattr(L, "use_custom_distance", False):
        rec["distance"] = float(getattr(L, "cutoff_distance", 0.0))
    return rec


# ─────────────────────────── camera ──────────────────────────────────────
def _camera_to_ir(scene):
    cam = scene.camera
    if cam is None:
        return None
    m = cam.matrix_world
    R = m.to_3x3()
    pos = m.translation
    fwd = (R @ mathutils.Vector((0, 0, -1))).normalized()
    up = (R @ mathutils.Vector((0, 1, 0))).normalized()
    dist = 10.0
    dof = getattr(cam.data, "dof", None)
    if dof and getattr(dof, "focus_distance", 0.0) > 0.0:
        dist = dof.focus_distance
    tgt = pos + fwd * max(1.0, dist)
    return {
        "pos": [pos.x, pos.y, pos.z],
        "tgt": [tgt.x, tgt.y, tgt.z],
        "up": [up.x, up.y, up.z],
        "fov": math.degrees(cam.data.angle_x),
        "persp": cam.data.type == "PERSP",
        "viewWidth": float(cam.data.ortho_scale) if cam.data.type == "ORTHO" else 0.0,
    }


# ─────────────────────────── scene walk ──────────────────────────────────
def extract_scene(context, backend="WebGL"):
    scene = context.scene
    depsgraph = context.evaluated_depsgraph_get()
    objs = list(scene.objects)

    # Stable per-export handles (also resolves parent references).
    handle = {o.name: i + 1 for i, o in enumerate(objs)}

    nodes, lights = [], []
    for o in objs:
        h = handle[o.name]
        parent = handle.get(o.parent.name) if (o.parent and o.parent.name in handle) else None
        mat16 = _matrix16(o)
        vis = _visible(o)

        if o.type in _MESHABLE:
            mesh = _extract_mesh(o, depsgraph)
            if mesh is None:
                nodes.append({"handle": h, "name": o.name, "parent": parent,
                              "matrix": mat16, "visible": vis, "helper": True})
                continue
            mat = None
            if o.material_slots and o.material_slots[0].material:
                mat = _material_to_pbr(o.material_slots[0].material)
            nodes.append({"handle": h, "name": o.name, "parent": parent,
                          "matrix": mat16, "visible": vis,
                          "selected": bool(o.select_get()) if hasattr(o, "select_get") else False,
                          "mesh": mesh, "material": mat})
        elif o.type == "LIGHT":
            rec = _light_to_ir(o, h)
            if rec:
                lights.append(rec)
        elif o.type == "EMPTY":
            nodes.append({"handle": h, "name": o.name, "parent": parent,
                          "matrix": mat16, "visible": vis, "helper": True})
        # cameras and other types: not scene-graph nodes here.

    fps_base = getattr(scene.render, "fps_base", 1.0) or 1.0

    # Honor Blender's color-management exposure (in stops) → three.js linear
    # toneMappingExposure, so the artist controls brightness in Blender.
    try:
        exposure = 2.0 ** float(scene.view_settings.exposure)
    except Exception:
        exposure = 1.0
    look = (getattr(scene.view_settings, "view_transform", "") or "").lower()
    tone = "AgX" if "agx" in look else ("Filmic" if "filmic" in look else "AgX")

    return {
        "nodes": nodes,
        "lights": lights,
        "camera": _camera_to_ir(scene),
        "rendererBackend": backend,
        "toneMapping": tone,
        "exposure": exposure,
        "fps": int(round(scene.render.fps / fps_base)),
    }
