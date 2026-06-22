import json
import os
import sys
import tempfile
import unittest


HERE = os.path.dirname(__file__)
PKG = os.path.join(HERE, "maxjs_blender")
if PKG not in sys.path:
    sys.path.insert(0, PKG)

import contract
import handles
import serialize


IDENTITY = [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0]


def material(name):
    return {
        "name": name,
        "model": "MeshPhysicalMaterial",
        "color": [0.25, 0.5, 0.75],
        "rough": 0.35,
        "metal": 0.1,
        "ior": 1.5,
        "side": 1,
    }


class TranslationContractTests(unittest.TestCase):
    def test_live_handles_preserve_existing_and_allocate_monotonically(self):
        initial, next_handle = handles.assign_stable_handles(["Cube", "Camera"])
        self.assertEqual(initial, {"Cube": 1, "Camera": 2})
        self.assertEqual(next_handle, 3)

        changed, next_handle = handles.assign_stable_handles(
            ["Camera", "Sphere"],
            existing_handle_map=initial,
            next_handle=next_handle,
        )

        self.assertEqual(changed["Camera"], 2)
        self.assertEqual(changed["Sphere"], 3)
        self.assertNotIn("Cube", changed)
        self.assertEqual(next_handle, 4)

    def test_live_handles_do_not_reuse_deleted_name_later_in_session(self):
        initial, next_handle = handles.assign_stable_handles(["Cube"])
        deleted, next_handle = handles.assign_stable_handles(
            [],
            existing_handle_map=initial,
            next_handle=next_handle,
        )
        recreated, next_handle = handles.assign_stable_handles(
            ["Cube"],
            existing_handle_map=deleted,
            next_handle=next_handle,
        )

        self.assertEqual(initial["Cube"], 1)
        self.assertEqual(recreated["Cube"], 2)
        self.assertEqual(next_handle, 3)

    def test_live_object_handles_survive_rename_by_object_identity(self):
        names, ids, next_handle = handles.assign_stable_object_handles(
            [("Cube", 101)],
        )
        renamed, renamed_ids, next_handle = handles.assign_stable_object_handles(
            [("HeroCube", 101)],
            existing_name_map=names,
            existing_id_map=ids,
            next_handle=next_handle,
        )

        self.assertEqual(names["Cube"], 1)
        self.assertEqual(renamed["HeroCube"], 1)
        self.assertEqual(renamed_ids[101], 1)
        self.assertNotIn("Cube", renamed)
        self.assertEqual(next_handle, 2)

    def test_live_object_handles_prefer_identity_over_reused_name(self):
        names, ids, next_handle = handles.assign_stable_object_handles(
            [("Cube", 101)],
        )
        renamed, renamed_ids, next_handle = handles.assign_stable_object_handles(
            [("HeroCube", 101), ("Cube", 202)],
            existing_name_map=names,
            existing_id_map=ids,
            next_handle=next_handle,
        )

        self.assertEqual(renamed["HeroCube"], 1)
        self.assertEqual(renamed["Cube"], 2)
        self.assertEqual(renamed_ids[101], 1)
        self.assertEqual(renamed_ids[202], 2)
        self.assertEqual(next_handle, 3)

    def test_live_object_handles_do_not_reuse_deleted_identity_with_same_name(self):
        names, ids, next_handle = handles.assign_stable_object_handles(
            [("Cube", 101)],
        )
        replaced, replaced_ids, next_handle = handles.assign_stable_object_handles(
            [("Cube", 202)],
            existing_name_map=names,
            existing_id_map=ids,
            next_handle=next_handle,
        )

        self.assertEqual(names["Cube"], 1)
        self.assertEqual(replaced["Cube"], 2)
        self.assertEqual(replaced_ids[202], 2)
        self.assertNotIn(101, replaced_ids)
        self.assertEqual(next_handle, 3)

    def test_material_hash_is_stable_and_name_independent(self):
        scene = {
            "nodes": [
                {
                    "handle": 1,
                    "name": "A",
                    "matrix": IDENTITY,
                    "mesh": {
                        "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0],
                        "indices": [0, 1, 2],
                    },
                    "material": material("Mat_A"),
                },
                {
                    "handle": 2,
                    "name": "B",
                    "matrix": IDENTITY,
                    "mesh": {
                        "positions": [0, 0, 1, 1, 0, 1, 0, 1, 1],
                        "indices": [0, 1, 2],
                    },
                    "material": material("Mat_B"),
                },
            ],
        }
        snap, _binary = serialize.build_snapshot(scene)
        self.assertEqual(len(snap["materials"]), 1)
        self.assertEqual(snap["nodes"][0]["matRef"], snap["nodes"][1]["matRef"])
        key_json = serialize._MaterialLibrary._canonical_json(material("Ignored"), key=True)
        self.assertEqual(snap["materials"][0]["hash"], contract.hash_fnv1a(key_json))

    def test_multi_material_groups_uv2_and_runtime_features(self):
        scene = {
            "rendererBackend": "WebGPU",
            "fps": 30,
            "nodes": [
                {
                    "handle": 10,
                    "name": "TwoSlots",
                    "matrix": IDENTITY,
                    "visible": True,
                    "selected": True,
                    "mesh": {
                        "positions": [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
                        "indices": [0, 1, 2, 0, 2, 3],
                        "uvs": [0, 0, 1, 0, 1, 1, 0, 1],
                        "uv2s": [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5],
                        "normals": [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
                        "groups": [[0, 3, 0], [3, 3, 1]],
                    },
                    "materials": [
                        {**material("Slot_A"), "color": [1, 0, 0]},
                        {**material("Slot_B"), "color": [0, 0, 1]},
                    ],
                }
            ],
            "lights": [{"h": 20, "name": "Sun", "type": contract.LIGHT_DIRECTIONAL}],
        }
        snap, binary = serialize.build_snapshot(scene)
        node = snap["nodes"][0]
        geo = node["geo"]

        self.assertEqual(node["groups"], [[0, 3, 0], [3, 3, 1]])
        self.assertEqual(len(node["matRefs"]), 2)
        self.assertNotIn("matRef", node)
        self.assertEqual(geo["iType"], "u16")
        self.assertEqual(geo["uvType"], "u16n")
        self.assertEqual(geo["uv2Type"], "u16n")
        self.assertEqual(geo["nType"], "i16n")
        self.assertLess(geo["uv2Off"], len(binary))
        self.assertEqual(snap["stats"]["producerBytes"], len(binary))
        self.assertEqual(snap["runtimeFeatures"]["renderer_pref"], "webgpu")
        self.assertEqual(snap["runtimeFeatures"]["post_fx"], [])
        self.assertEqual(snap["runtimeFeatures"]["stats"]["meshes"], 1)
        self.assertEqual(snap["runtimeFeatures"]["stats"]["materials"], 2)
        self.assertEqual(snap["runtimeFeatures"]["stats"]["lights"], 1)

    def test_live_ipr_scene_bin_uses_max_fullsync_channel_layout(self):
        scene = {
            "nodes": [
                {
                    "handle": 10,
                    "name": "LiveMesh",
                    "matrix": IDENTITY,
                    "visible": True,
                    "mesh": {
                        "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0],
                        "indices": [0, 1, 2],
                        "uvs": [0, 0, 0.5, 0, 0, 0.5],
                        "normals": [0, 0, 1, 0, 0, 1, 0, 0, 1],
                    },
                    "material": material("Mat"),
                }
            ],
        }
        snap, _binary = serialize.build_snapshot(scene, adaptive_geometry=False)
        geo = snap["nodes"][0]["geo"]

        self.assertNotIn("iType", geo)
        self.assertNotIn("uvType", geo)
        self.assertNotIn("nType", geo)

    def test_geo_fast_packet_matches_live_binary_contract(self):
        mesh = {
            "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0],
            "indices": [0, 1, 2],
            "uvs": [0, 0, 1, 0, 0, 1],
            "normals": [0, 0, 1, 0, 0, 1, 0, 0, 1],
            "groups": [[0, 3, 0]],
        }
        meta, blob = serialize.build_geo_fast_update(
            42,
            mesh,
            materials=[material("Slot")],
        )

        self.assertEqual(meta["type"], "geo_fast")
        self.assertEqual(meta["h"], 42)
        self.assertEqual(meta["vOff"], 0)
        self.assertEqual(meta["vN"], 9)
        self.assertEqual(meta["iOff"], 36)
        self.assertEqual(meta["iN"], 3)
        self.assertEqual(meta["uvOff"], 48)
        self.assertEqual(meta["uvN"], 6)
        self.assertEqual(meta["nOff"], 72)
        self.assertEqual(meta["nN"], 9)
        self.assertEqual(meta["groups"], [[0, 3, 0]])
        self.assertEqual(len(meta["mats"]), 1)
        self.assertEqual(len(blob), 108)

    def test_scene_camera_list_matches_max_metadata_shape(self):
        scene = {
            "nodes": [],
            "sceneCameras": [{"h": 7, "n": "Camera"}],
            "lockedCamera": 0,
        }
        snap, _binary = serialize.build_snapshot(scene)

        self.assertEqual(snap["sceneCameras"], [{"h": 7, "n": "Camera"}])
        self.assertEqual(snap["lockedCamera"], 0)

    def test_camera_clip_planes_are_serialized_for_snapshot_and_ui(self):
        scene = {
            "nodes": [],
            "camera": {
                "pos": [1, 2, 3],
                "tgt": [0, 0, 0],
                "up": [0, 0, 1],
                "fov": 45.0,
                "persp": True,
                "near": 0.25,
                "far": 2500.0,
            },
        }
        snap, _binary = serialize.build_snapshot(scene)

        self.assertEqual(snap["camera"]["near"], 0.25)
        self.assertEqual(snap["camera"]["far"], 2500.0)
        self.assertEqual(snap["snapshotUi"]["camera"]["near"], 0.25)
        self.assertEqual(snap["snapshotUi"]["camera"]["far"], 2500.0)
        self.assertEqual(snap["snapshotUi"]["cameraClip"], {"near": 0.25, "far": 2500.0})

    def test_write_snapshot_outputs_valid_shared_runtime_files(self):
        scene = {
            "nodes": [],
            "camera": {"pos": [1, 2, 3], "tgt": [0, 0, 0], "up": [0, 0, 1],
                       "fov": 45.0, "persp": True},
        }
        with tempfile.TemporaryDirectory() as tmp:
            stats = serialize.write_snapshot(tmp, scene)
            self.assertEqual(stats["bin_bytes"], 4)
            with open(os.path.join(tmp, "snapshot.json"), "r", encoding="utf-8") as f:
                snap = json.load(f)
            self.assertEqual(snap["type"], contract.SNAPSHOT_TYPE)
            self.assertTrue(os.path.isfile(os.path.join(tmp, contract.BIN_NAME)))


if __name__ == "__main__":
    unittest.main()
