# pump.py — Blender live IPR delta pump.
#
# Each tick it diffs the evaluated scene against the last-sent state and emits a
# single MXJB frame containing ONLY what changed — the same protocol the 3ds Max
# plugin streams over WebView2. Change detection is mandatory: the pump runs at
# ~20 Hz, so handlers that don't diff would flood the wire (mirrors the C++
# rule that finalizeSceneSnapshot handlers must change-detect).
#
# Handles MUST match the initial snapshot's handle map (captured at IPR start),
# so the browser's nodeMap resolves each command to the right object.

try:
    from . import contract, extract_blender
except ImportError:
    import contract
    import extract_blender


def _round_seq(seq, ndigits):
    return tuple(round(float(x), ndigits) for x in seq)


class DeltaPump:
    def __init__(self, handle_map):
        self.handle_map = dict(handle_map)   # object name -> handle (same as snapshot)
        self._frame = 1                      # frame 0 == the initial snapshot
        self._xform = {}
        self._vis = {}
        self._mat = {}
        self._light = {}
        self._cam = None

    # ── material scalar (base color / rough / metal / opacity) ──
    def _principled_scalar(self, obj):
        if not obj.material_slots or not obj.material_slots[0].material:
            return None
        mat = obj.material_slots[0].material
        node = extract_blender._find_principled(mat)
        if node is None:
            col = list(getattr(mat, "diffuse_color", (0.8, 0.8, 0.8, 1.0)))[:3]
            return ([float(c) for c in col], float(getattr(mat, "roughness", 0.5)),
                    float(getattr(mat, "metallic", 0.0)), 1.0)
        base = extract_blender._inp(node, ["Base Color"], (0.8, 0.8, 0.8, 1.0))
        return ([float(base[0]), float(base[1]), float(base[2])],
                float(extract_blender._inp(node, ["Roughness"], 0.5)),
                float(extract_blender._inp(node, ["Metallic"], 0.0)),
                float(extract_blender._inp(node, ["Alpha"], 1.0)))

    def seed(self, context):
        """Prime caches from the current scene without emitting (the browser
        already has this state from the initial snapshot)."""
        self._build(context, seed=True)

    def build_frame(self, context):
        """Return MXJB frame bytes for what changed since last call, or None."""
        return self._build(context, seed=False)

    def _build(self, context, seed):
        scene = context.scene
        b = contract.DeltaFrameBuilder(self._frame)
        b.begin_frame()
        emitted = 0

        for o in scene.objects:
            h = self.handle_map.get(o.name)
            if not h:
                continue

            if o.type in extract_blender._MESHABLE or o.type == "EMPTY":
                m = extract_blender._matrix16(o)
                xkey = _round_seq(m, 5)
                if self._xform.get(h) != xkey:
                    self._xform[h] = xkey
                    if not seed:
                        b.update_transform(h, m); emitted += 1

                vis = extract_blender._visible(o)
                if self._vis.get(h) != vis:
                    self._vis[h] = vis
                    if not seed:
                        b.update_visibility(h, vis); emitted += 1

                if o.type in extract_blender._MESHABLE:
                    ms = self._principled_scalar(o)
                    if ms is not None:
                        mkey = (_round_seq(ms[0], 4), round(ms[1], 4), round(ms[2], 4), round(ms[3], 4))
                        if self._mat.get(h) != mkey:
                            self._mat[h] = mkey
                            if not seed:
                                b.update_material_scalar(h, ms[0], ms[1], ms[2], ms[3]); emitted += 1

            elif o.type == "LIGHT":
                rec = extract_blender._light_to_ir(o, h)
                if rec is None:
                    continue
                rec["matrix16"] = extract_blender._matrix16(o)
                rec["groundColor"] = (0.0, 0.0, 0.0)
                rec["visible"] = extract_blender._visible(o)
                lkey = (_round_seq(rec["matrix16"], 4), rec["type"], _round_seq(rec["color"], 4),
                        round(rec["intensity"], 3), round(rec.get("angle", 0.0), 4),
                        round(rec.get("penumbra", 0.0), 4), rec["visible"])
                if self._light.get(h) != lkey:
                    self._light[h] = lkey
                    if not seed:
                        b.update_light(h, rec); emitted += 1

        cam = extract_blender._camera_to_ir(scene)
        if cam is not None:
            ckey = (_round_seq(cam["pos"], 5), _round_seq(cam["tgt"], 5), _round_seq(cam["up"], 5),
                    round(cam["fov"], 4), bool(cam["persp"]))
            if self._cam != ckey:
                self._cam = ckey
                if not seed:
                    b.update_camera(cam["pos"], cam["tgt"], cam["up"], cam["fov"],
                                    cam["persp"], cam.get("viewWidth", 0.0)); emitted += 1

        if seed or emitted == 0:
            return None
        b.end_frame()
        self._frame += 1
        return b.bytes()
