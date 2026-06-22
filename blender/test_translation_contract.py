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
