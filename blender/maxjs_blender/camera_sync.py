# camera_sync.py - Blender viewport/scene-camera sync for Live IPR.
#
# Camera mode remains controlled by the max.js editor camera dropdown:
# handle 0 = Blender's active 3D View viewport, nonzero = Blender camera object.

import bpy

try:
    from . import extract_blender, server
except ImportError:
    import extract_blender
    import server


def capture_viewport_space(context):
    space = getattr(context, "space_data", None)
    if getattr(space, "type", None) == "VIEW_3D" and getattr(space, "region_3d", None) is not None:
        return space
    return extract_blender._viewport_space_from_context(context)


def viewport_camera_ir(scene, state):
    return extract_blender._viewport_camera_to_ir(
        bpy.context,
        preferred_space=state.get("viewport_space"),
        scene=scene,
    )


def camera_for_locked_handle(scene, state, handle):
    if not handle:
        return viewport_camera_ir(scene, state)
    handle_map = state.get("handle_map") or {}
    for obj in scene.objects:
        if handle_map.get(obj.name) == handle and getattr(obj, "type", None) == "CAMERA":
            return extract_blender._camera_object_to_ir(obj)
    server.set_locked_camera(0)
    return viewport_camera_ir(scene, state)


def push_camera_update(scene, state):
    cam = camera_for_locked_handle(scene, state, server.get_locked_camera())
    pmp = state.get("pump")
    if cam is not None and pmp is not None:
        frame = pmp.build_camera_frame(cam)
        if frame:
            server.push_delta(frame)


def start_modal_pump():
    try:
        bpy.ops.maxjs.ipr_camera_pump("INVOKE_DEFAULT")
    except Exception as ex:
        print("[max.js IPR] camera pump start failed:", repr(ex))


class MAXJS_OT_ipr_camera_pump(bpy.types.Operator):
    bl_idname = "maxjs.ipr_camera_pump"
    bl_label = "max.js IPR camera pump"

    _timer = None

    @staticmethod
    def _live_ipr():
        try:
            from . import live_ipr
        except ImportError:
            import live_ipr
        return live_ipr

    def _remove_timer(self, context):
        if self._timer is not None:
            try:
                context.window_manager.event_timer_remove(self._timer)
            except Exception:
                pass
            self._timer = None
        self._live_ipr().state()["camera_modal_running"] = False

    def invoke(self, context, event):
        state = self._live_ipr().state()
        if state.get("camera_modal_running"):
            return {"CANCELLED"}
        self._timer = context.window_manager.event_timer_add(1.0 / 60.0, window=context.window)
        context.window_manager.modal_handler_add(self)
        state["camera_modal_running"] = True
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        live_ipr = self._live_ipr()
        state = live_ipr.state()
        if not state.get("running"):
            self._remove_timer(context)
            return {"CANCELLED"}
        if event.type == "TIMER":
            scene = bpy.data.scenes.get(state.get("scene") or "") or context.scene
            try:
                push_camera_update(scene, state)
            except Exception as ex:
                print("[max.js IPR] camera pump error:", repr(ex))
        return {"PASS_THROUGH"}
