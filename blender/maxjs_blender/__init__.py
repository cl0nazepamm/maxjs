# max.js for Blender — feed a Blender scene into the shared max.js web/ runtime.
#
# The add-on is intentionally thin: it wires Blender UI/operators to the
# DCC-agnostic core (serialize.py) via the only Blender-coupled module
# (extract_blender.py), and previews through the shared runtime (server.py).

bl_info = {
    "name": "max.js (Blender bridge)",
    "author": "max.js",
    "version": (0, 1, 0),
    "blender": (4, 1, 0),
    "location": "View3D > Sidebar (N) > max.js",
    "description": "Export the Blender scene into the shared max.js web/ runtime "
                   "(snapshot.json + scene.bin) and preview it in the browser.",
    "category": "Import-Export",
}

import os
import tempfile
import webbrowser

import bpy

try:
    from . import extract_blender, serialize, server, pump
except ImportError:  # running the modules outside the package
    import extract_blender
    import serialize
    import server
    import pump


def _repo_web_root():
    """Best guess at the repo's shared web/ folder: blender/maxjs_blender/ -> ../../web."""
    here = os.path.dirname(__file__)
    return os.path.normpath(os.path.join(here, "..", "..", "web"))


def _default_out_dir():
    return os.path.join(tempfile.gettempdir(), "maxjs_blender_preview")


def _resolve_web_root(scene):
    custom = bpy.path.abspath(scene.maxjs_web_root) if scene.maxjs_web_root else ""
    return custom if custom and os.path.isdir(custom) else _repo_web_root()


def _export(context):
    scene = context.scene
    out_dir = bpy.path.abspath(scene.maxjs_out_dir) if scene.maxjs_out_dir else _default_out_dir()
    ir = extract_blender.extract_scene(context, backend=scene.maxjs_backend)
    stats = serialize.write_snapshot(out_dir, ir)
    stats["out_dir"] = out_dir
    stats["handle_map"] = ir["handle_map"]
    return stats


# ── live IPR: an event-driven delta pump streaming MXJB frames ──
# Driven by depsgraph_update_post, so frames fire the instant the user edits
# (not on a fixed clock) and each frame diffs only the objects Blender flagged
# dirty. Pushed to the browser over SSE — this is what makes it feel like Max.
_IPR = {"running": False, "pump": None, "scene": None}


class _Ctx:
    """Minimal context shim for the pump (it only needs .scene)."""
    def __init__(self, scene):
        self.scene = scene

    def evaluated_depsgraph_get(self):
        return bpy.context.evaluated_depsgraph_get()


def _dirty_object_names(scene, depsgraph):
    """Object names touched by this depsgraph update (transform/shading), mapping
    Material/Light datablock edits back to the objects that use them."""
    names = set()
    for upd in depsgraph.updates:
        idd = getattr(upd, "id", None)
        if idd is None:
            continue
        idd = getattr(idd, "original", idd)
        if isinstance(idd, bpy.types.Object):
            names.add(idd.name)
        elif isinstance(idd, bpy.types.Material):
            for o in scene.objects:
                if any(ms.material == idd for ms in o.material_slots):
                    names.add(o.name)
        elif isinstance(idd, bpy.types.Light):
            for o in scene.objects:
                if o.data == idd:
                    names.add(o.name)
    return names


def _on_depsgraph(scene, depsgraph):
    st = _IPR
    if not st["running"] or scene.name != st["scene"]:
        return
    try:
        names = _dirty_object_names(scene, depsgraph)
        if not names:
            return
        frame = st["pump"].build_frame(_Ctx(scene), only_names=names)
        if frame:
            server.push_delta(frame)
    except Exception as ex:
        print("[max.js IPR] depsgraph error:", repr(ex))


def _ipr_stop():
    _IPR["running"] = False
    handlers = bpy.app.handlers.depsgraph_update_post
    if _on_depsgraph in handlers:
        handlers.remove(_on_depsgraph)
    server.set_ipr(False)
    server.clear_delta()


class MAXJS_OT_export_only(bpy.types.Operator):
    bl_idname = "maxjs.export_only"
    bl_label = "Export snapshot (max.js)"
    bl_description = "Write snapshot.json + scene.bin for the current scene"
    bl_options = {"REGISTER"}

    def execute(self, context):
        try:
            stats = _export(context)
        except Exception as ex:
            self.report({"ERROR"}, "max.js export failed: %r" % ex)
            return {"CANCELLED"}
        self.report({"INFO"}, "max.js: %d nodes, %d materials, %d lights, %d bytes → %s"
                    % (stats["nodes"], stats["materials"], stats["lights"],
                       stats["bin_bytes"], stats["out_dir"]))
        return {"FINISHED"}


class MAXJS_OT_export_preview(bpy.types.Operator):
    bl_idname = "maxjs.export_preview"
    bl_label = "Export & Preview (max.js)"
    bl_description = "Export the scene and open it in the shared max.js runtime in a browser"
    bl_options = {"REGISTER"}

    def execute(self, context):
        scene = context.scene
        web_root = _resolve_web_root(scene)
        if not os.path.isdir(web_root):
            self.report({"ERROR"}, "max.js web/ runtime not found: %s (set it in the panel)" % web_root)
            return {"CANCELLED"}
        try:
            stats = _export(context)
        except Exception as ex:
            self.report({"ERROR"}, "max.js export failed: %r" % ex)
            return {"CANCELLED"}

        _httpd, port = server.serve(web_root, stats["out_dir"], port=scene.maxjs_port)
        page = "snapshot_webgpu.html" if scene.maxjs_backend == "WebGPU" else "snapshot.html"
        url = "http://127.0.0.1:%d/%s" % (port, page)
        webbrowser.open(url)
        self.report({"INFO"}, "max.js preview: %d nodes, %d bytes → %s"
                    % (stats["nodes"], stats["bin_bytes"], url))
        return {"FINISHED"}


class MAXJS_OT_ipr_start(bpy.types.Operator):
    bl_idname = "maxjs.ipr_start"
    bl_label = "Start Live IPR (max.js)"
    bl_description = "Stream scene edits to the browser as MXJB delta frames"
    bl_options = {"REGISTER"}

    def execute(self, context):
        scene = context.scene
        web_root = _resolve_web_root(scene)
        if not os.path.isdir(web_root):
            self.report({"ERROR"}, "max.js web/ runtime not found: %s" % web_root)
            return {"CANCELLED"}
        try:
            stats = _export(context)
            pmp = pump.DeltaPump(stats["handle_map"])
            pmp.seed(context)  # prime caches from current state; emits nothing
        except Exception as ex:
            self.report({"ERROR"}, "max.js IPR export failed: %r" % ex)
            return {"CANCELLED"}

        server.clear_delta()
        _httpd, port = server.serve(web_root, stats["out_dir"], port=scene.maxjs_port, ipr=True)
        _IPR.update(running=True, pump=pmp, scene=scene.name)
        if _on_depsgraph not in bpy.app.handlers.depsgraph_update_post:
            bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)

        page = "snapshot_webgpu.html" if scene.maxjs_backend == "WebGPU" else "snapshot.html"
        url = "http://127.0.0.1:%d/%s" % (port, page)
        webbrowser.open(url)
        self.report({"INFO"}, "max.js IPR live (event-driven) → %s" % url)
        return {"FINISHED"}


class MAXJS_OT_ipr_stop(bpy.types.Operator):
    bl_idname = "maxjs.ipr_stop"
    bl_label = "Stop Live IPR (max.js)"
    bl_description = "Stop streaming delta frames"
    bl_options = {"REGISTER"}

    def execute(self, context):
        _ipr_stop()
        self.report({"INFO"}, "max.js IPR stopped")
        return {"FINISHED"}


class MAXJS_PT_panel(bpy.types.Panel):
    bl_label = "max.js"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "max.js"

    def draw(self, context):
        scene = context.scene
        layout = self.layout
        col = layout.column(align=True)
        col.prop(scene, "maxjs_backend", text="Backend")
        col.prop(scene, "maxjs_out_dir", text="Out")
        col.prop(scene, "maxjs_web_root", text="web/")
        col.prop(scene, "maxjs_port", text="Port")
        layout.separator()
        layout.operator("maxjs.export_preview", icon="PLAY")
        layout.operator("maxjs.export_only", icon="EXPORT")

        layout.separator()
        box = layout.box()
        box.label(text="Live IPR", icon="RENDER_ANIMATION")
        if _IPR["running"]:
            box.operator("maxjs.ipr_stop", icon="PAUSE")
            box.label(text="● streaming (event-driven)", icon="REC")
        else:
            box.operator("maxjs.ipr_start", icon="PLAY")


_CLASSES = (MAXJS_OT_export_only, MAXJS_OT_export_preview,
            MAXJS_OT_ipr_start, MAXJS_OT_ipr_stop, MAXJS_PT_panel)


def register():
    bpy.types.Scene.maxjs_backend = bpy.props.EnumProperty(
        name="Backend",
        items=[("WebGL", "WebGL", "snapshot.html — broadest compatibility"),
               ("WebGPU", "WebGPU", "snapshot_webgpu.html — full TSL/GI pipeline")],
        default="WebGL")
    bpy.types.Scene.maxjs_out_dir = bpy.props.StringProperty(
        name="Out dir", subtype="DIR_PATH", default="")
    bpy.types.Scene.maxjs_web_root = bpy.props.StringProperty(
        name="web/ root", subtype="DIR_PATH", default="",
        description="Shared max.js web/ runtime. Empty = auto-detect from repo layout.")
    bpy.types.Scene.maxjs_port = bpy.props.IntProperty(
        name="Port", default=0, min=0, max=65535,
        description="0 = pick a free port")
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    try:
        _ipr_stop()
    except Exception:
        pass
    try:
        server.stop()
    except Exception:
        pass
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)
    for prop in ("maxjs_backend", "maxjs_out_dir", "maxjs_web_root", "maxjs_port"):
        if hasattr(bpy.types.Scene, prop):
            delattr(bpy.types.Scene, prop)


if __name__ == "__main__":
    register()
