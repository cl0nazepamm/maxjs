# Pure-python smoke test for the DCC-agnostic serializer + format contract.
# Runs without Blender (no bpy). numpy optional — contract.py falls back to the
# stdlib `array` module.
#
#   python blender/tests/test_serialize_smoke.py

import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "maxjs_blender"))

import contract  # noqa: E402
import serialize  # noqa: E402


def _unit_cube_ir():
    # 8 corners, 12 triangles. UVs in [0,1]; unit-length axis normals.
    p = [
        0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
        0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1,
    ]
    idx = [
        0, 1, 2, 0, 2, 3,  4, 6, 5, 4, 7, 6,
        0, 4, 5, 0, 5, 1,  1, 5, 6, 1, 6, 2,
        2, 6, 7, 2, 7, 3,  3, 7, 4, 3, 4, 0,
    ]
    n = [0.577, 0.577, 0.577] * 8
    uv = [0, 0,  1, 0,  1, 1,  0, 1,  0, 0,  1, 0,  1, 1,  0, 1]
    return {
        "handle": 1, "name": "Cube", "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1],
        "visible": True, "mesh": {"positions": p, "indices": idx, "normals": n, "uvs": uv},
        "material": {"name": "Red", "model": "MeshStandardMaterial",
                     "color": [1, 0, 0], "rough": 0.4, "metal": 0.0},
    }


def _big_ir():
    # >65536 distinct vertices forces int32 indices and likely f32 UVs (>1).
    v = 70000
    p = [float(i % 1000) for i in range(v * 3)]
    idx = [0, 1, 2] + [v - 3, v - 2, v - 1]
    uv = [2.0, 3.0] * v  # out of [0,1] → f32
    return {"handle": 2, "name": "Big",
            "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            "visible": True, "mesh": {"positions": p, "indices": idx, "uvs": uv},
            # identical material to the cube → exercises dedup into one entry.
            "material": {"name": "Red", "model": "MeshStandardMaterial",
                         "color": [1, 0, 0], "rough": 0.4, "metal": 0.0}}


def _check_block(buf, off, n, elem_bytes, align, label):
    assert off % align == 0, "%s offset %d not %d-aligned" % (label, off, align)
    assert off + n * elem_bytes <= len(buf), "%s out of range" % label


def main():
    scene = {"nodes": [_unit_cube_ir(), _big_ir()],
             "lights": [{"h": 9, "type": 0, "intensity": 2400.0,
                         "pos": [0, 0, 10], "dir": [0, 0, -1], "color": [1, 1, 1]}],
             "camera": {"pos": [10, -10, 8], "tgt": [0, 0, 0], "up": [0, 0, 1],
                        "fov": 45.0, "persp": True}}
    snap, buf = serialize.build_snapshot(scene)

    # top-level shape
    assert snap["type"] == "scene_bin"
    assert snap["bin"] == "scene.bin"
    assert snap["stats"]["producerBytes"] == len(buf)
    assert len(snap["nodes"]) == 2
    assert len(snap["materials"]) == 1 and snap["materials"][0]["id"] == 1  # deduped
    assert snap["nodes"][0]["matRef"] == 1 and snap["nodes"][1]["matRef"] == 1

    # cube node: small mesh ⇒ u16 indices, u16n uvs, i16n normals
    cube = snap["nodes"][0]["geo"]
    assert cube["iType"] == "u16", cube
    assert cube["uvType"] == "u16n", cube
    assert cube["nType"] == "i16n", cube
    _check_block(buf, cube["vOff"], cube["vN"], 4, 4, "cube.v")
    _check_block(buf, cube["iOff"], cube["iN"], 2, 2, "cube.i")
    _check_block(buf, cube["uvOff"], cube["uvN"], 2, 2, "cube.uv")
    _check_block(buf, cube["nOff"], cube["nN"], 2, 2, "cube.n")
    # round-trip the first vertex (f32)
    vx = struct.unpack_from("<3f", buf, cube["vOff"])
    assert vx == (0.0, 0.0, 0.0), vx
    # round-trip a u16n uv (0,0 and 1,0) → 0 and 65535
    u0, v0, u1, v1 = struct.unpack_from("<4H", buf, cube["uvOff"])
    assert (u0, v0) == (0, 0) and u1 == 65535, (u0, v0, u1, v1)

    # big node: huge mesh ⇒ int32 indices (no iType), f32 uvs (no uvType)
    big = snap["nodes"][1]["geo"]
    assert "iType" not in big, big
    assert "uvType" not in big, big
    _check_block(buf, big["vOff"], big["vN"], 4, 4, "big.v")
    _check_block(buf, big["iOff"], big["iN"], 4, 4, "big.i")
    # last index value preserved through int32
    last = struct.unpack_from("<i", buf, big["iOff"] + (big["iN"] - 1) * 4)[0]
    assert last == 70000 - 1, last

    # snapshot.json must be valid JSON
    json.loads(json.dumps(snap))

    print("OK: nodes=%d materials=%d lights=%d bin=%d bytes"
          % (len(snap["nodes"]), len(snap["materials"]), len(snap["lights"]), len(buf)))
    print("    cube geo:", cube)
    print("    big  geo:", big)


if __name__ == "__main__":
    main()
