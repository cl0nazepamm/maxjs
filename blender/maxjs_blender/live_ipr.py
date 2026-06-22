# live_ipr.py - Live IPR session lifecycle for the Blender bridge.
#
# This owns the Blender event hooks and session state. Packet construction stays
# in pump.py, camera-source policy stays in camera_sync.py, and transport stays
# in server.py.

import json
import os
import webbrowser

import bpy

try:
    from . import camera_sync, extract_blender, pump, serialize, server
except ImportError:
    import camera_sync
    import extract_blender
    import pump
    import serialize
    import server


_STATE = {
    "running": False,
    "pump": None,
    "scene": None,
    "out_dir": None,
    "viewport_space": None,
    "handle_map": {},
    "handle_id_map": {},
    "next_handle": 1,
    "structure_sig": None,
    "syncing_full": False,
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


def _next_handle_from_stats(stats):
    next_handle = stats.get("next_handle")
    if next_handle is not None:
        return int(next_handle)
    handles = [int(v) for v in (stats.get("handle_map") or {}).values()]
    handles.extend(int(v) for v in (stats.get("handle_id_map") or {}).values())
    return (max(handles) + 1) if handles else 1


def _pointer_id(value):
    try:
        return int(value.as_pointer())
    except ReferenceError:
        return 0
    except Exception:
        return 0


def _structure_signature(scene):
    """Object-table signature that maps to Max's full-sync dirty condition."""
    rows = []
    for obj in scene.objects:
        parent = getattr(obj, "parent", None)
        data = getattr(obj, "data", None)
        rows.append((
            obj.name,
            getattr(obj, "type", ""),
            parent.name if parent else "",
            _pointer_id(obj),
            _pointer_id(data) if data is not None else 0,
        ))
    return tuple(rows)


def _current_camera_ir(scene):
    return camera_sync.camera_for_locked_handle(
        scene,
        _STATE,
        server.get_locked_camera(),
    )


def _build_full_scene_packet(scene):
    context = _Ctx(scene)
    ir = extract_blender.extract_scene(
        context,
        backend=getattr(scene, "maxjs_backend", "WebGL"),
        handle_map=_STATE.get("handle_map") or {},
        handle_id_map=_STATE.get("handle_id_map") or {},
        next_handle=_STATE.get("next_handle") or 1,
    )
    camera = _current_camera_ir(scene)
    if camera is not None:
        ir["camera"] = camera
    ir["lockedCamera"] = int(server.get_locked_camera() or 0)
    snap, binary = serialize.build_snapshot(ir, adaptive_geometry=False)
    return context, ir, snap, binary, camera


def _write_current_scene_files(snap, binary):
    out_dir = _STATE.get("out_dir")
    if not out_dir:
        return
    os.makedirs(out_dir, exist_ok=True)
    bin_name = snap.get("bin") or "scene.bin"
    with open(os.path.join(out_dir, bin_name), "wb") as f:
        f.write(binary)
    with open(os.path.join(out_dir, "snapshot.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f, separators=(",", ":"))


def _send_full_scene_resync(scene, reason):
    if _STATE.get("syncing_full"):
        return False
    _STATE["syncing_full"] = True
    try:
        context, ir, snap, binary, camera = _build_full_scene_packet(scene)
        new_pump = pump.DeltaPump(ir["handle_map"])
        new_pump.seed(context)
        if camera is not None:
            new_pump.seed_camera(camera)

        _write_current_scene_files(snap, binary)
        server.clear_delta()
        server.push_shared_buffer(snap, binary)
        _STATE.update(
            pump=new_pump,
            handle_map=ir["handle_map"],
            handle_id_map=ir.get("handle_id_map", {}),
            next_handle=ir.get("next_handle") or _next_handle_from_stats(ir),
            structure_sig=_structure_signature(scene),
        )
        print("[max.js IPR] scene_bin resync (%s): %d nodes, %d bytes" %
              (reason, len(snap.get("nodes", [])), len(binary)))
        return True
    finally:
        _STATE["syncing_full"] = False


def _on_depsgraph(scene, depsgraph):
    if not _STATE["running"] or scene.name != _STATE["scene"]:
        return
    try:
        structure_sig = _structure_signature(scene)
        if _STATE.get("structure_sig") is not None and structure_sig != _STATE["structure_sig"]:
            _send_full_scene_resync(scene, "structure")
            return

        names, geometry_names = _dirty_update_sets(scene, depsgraph)
        known_handles = _STATE.get("handle_map") or {}
        unknown_names = {
            name for name in (names | geometry_names)
            if name not in known_handles and scene.objects.get(name) is not None
        }
        if unknown_names:
            _send_full_scene_resync(scene, "new handles")
            return

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
        out_dir=stats["out_dir"],
        viewport_space=viewport_space,
        handle_map=stats["handle_map"],
        handle_id_map=stats.get("handle_id_map", {}),
        next_handle=_next_handle_from_stats(stats),
        structure_sig=_structure_signature(scene),
        syncing_full=False,
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
        out_dir=None,
        viewport_space=None,
        handle_map={},
        handle_id_map={},
        next_handle=1,
        structure_sig=None,
        syncing_full=False,
        camera_modal_running=False,
    )
