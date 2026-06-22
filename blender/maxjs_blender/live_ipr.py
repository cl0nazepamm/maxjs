# live_ipr.py - Live IPR session lifecycle for the Blender bridge.
#
# This owns the Blender event hooks and session state. Packet construction stays
# in pump.py, camera-source policy stays in camera_sync.py, and transport stays
# in server.py.

import os
import webbrowser

import bpy

try:
    from . import camera_sync, extract_blender, pump, server
except ImportError:
    import camera_sync
    import extract_blender
    import pump
    import server


_STATE = {
    "running": False,
    "pump": None,
    "scene": None,
    "viewport_space": None,
    "handle_map": {},
    "camera_modal_running": False,
}


class _Ctx:
    """Minimal context shim for DeltaPump; it only needs .scene and depsgraph."""
    def __init__(self, scene):
        self.scene = scene

    def evaluated_depsgraph_get(self):
        return bpy.context.evaluated_depsgraph_get()


def state():
    return _STATE


def is_running():
    return bool(_STATE.get("running"))


def _dirty_update_sets(scene, depsgraph):
    """Return (delta_names, geometry_names) for this depsgraph update."""
    names = set()
    geometry = set()

    def add_data_users(data_block):
        for obj in scene.objects:
            if obj.data == data_block:
                names.add(obj.name)
                if obj.type in extract_blender._MESHABLE:
                    geometry.add(obj.name)

    for upd in depsgraph.updates:
        idd = getattr(upd, "id", None)
        if idd is None:
            continue
        idd = getattr(idd, "original", idd)
        is_geometry = bool(getattr(upd, "is_updated_geometry", False))
        if isinstance(idd, bpy.types.Object):
            names.add(idd.name)
            if is_geometry and idd.type in extract_blender._MESHABLE:
                geometry.add(idd.name)
            continue

        data_types = [bpy.types.Mesh, bpy.types.Curve]
        for type_name in ("SurfaceCurve", "MetaBall", "TextCurve"):
            typ = getattr(bpy.types, type_name, None)
            if typ is not None:
                data_types.append(typ)
        if isinstance(idd, tuple(data_types)):
            add_data_users(idd)
            continue
        if isinstance(idd, bpy.types.Material):
            for obj in scene.objects:
                if any(ms.material == idd for ms in obj.material_slots):
                    names.add(obj.name)
            continue
        if isinstance(idd, bpy.types.Light):
            for obj in scene.objects:
                if obj.data == idd:
                    names.add(obj.name)
            continue
        if isinstance(idd, bpy.types.Camera):
            for obj in scene.objects:
                if obj.data == idd:
                    names.add(obj.name)
            continue
    return names, geometry


def _on_depsgraph(scene, depsgraph):
    if not _STATE["running"] or scene.name != _STATE["scene"]:
        return
    try:
        names, geometry_names = _dirty_update_sets(scene, depsgraph)
        camera_names = {obj.name for obj in scene.objects if getattr(obj, "type", None) == "CAMERA"}
        names.difference_update(camera_names)
        if names:
            frame = _STATE["pump"].build_frame(_Ctx(scene), only_names=names)
            if frame:
                server.push_delta(frame)
        if geometry_names:
            for meta, blob in _STATE["pump"].build_geometry_updates(_Ctx(scene), only_names=geometry_names):
                server.push_shared_buffer(meta, blob)
    except Exception as ex:
        print("[max.js IPR] depsgraph error:", repr(ex))


def start(context, web_root, export_snapshot):
    scene = context.scene
    if not os.path.isdir(web_root):
        raise RuntimeError("max.js web/ runtime not found: %s" % web_root)

    viewport_space = camera_sync.capture_viewport_space(context)
    viewport_camera = extract_blender._viewport_camera_to_ir(
        context,
        preferred_space=viewport_space,
        scene=scene,
    )

    # Keep Blender IPR on the Max live fullsync layout so geo_fast can patch
    # the same buffers in place.
    stats = export_snapshot(context, adaptive_geometry=False, camera_override=viewport_camera)
    pmp = pump.DeltaPump(stats["handle_map"])
    pmp.seed(context)
    if viewport_camera is not None:
        pmp.seed_camera(viewport_camera)

    server.clear_delta()
    server.set_locked_camera(0)
    _httpd, port = server.serve(web_root, stats["out_dir"], port=scene.maxjs_port, ipr=True)
    _STATE.update(
        running=True,
        pump=pmp,
        scene=scene.name,
        viewport_space=viewport_space,
        handle_map=stats["handle_map"],
    )
    if _on_depsgraph not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)
    camera_sync.start_modal_pump()

    url = "http://127.0.0.1:%d/index.html" % port
    webbrowser.open(url)
    result = dict(stats)
    result["url"] = url
    return result


def stop():
    _STATE["running"] = False
    handlers = bpy.app.handlers.depsgraph_update_post
    if _on_depsgraph in handlers:
        handlers.remove(_on_depsgraph)
    server.set_ipr(False)
    server.clear_delta()
    server.set_locked_camera(0)
    _STATE.update(
        pump=None,
        scene=None,
        viewport_space=None,
        handle_map={},
        camera_modal_running=False,
    )
