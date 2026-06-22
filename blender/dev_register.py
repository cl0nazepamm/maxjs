# max.js Blender dev bootstrap — the analog of how dev.bat launches Max with
# the repo as the live source. Loads the add-on package straight from THIS repo
# working copy (so `git pull` + relaunch picks up changes; no install/copy),
# registers it, and leaves web/ auto-detection pointed at the repo.
#
# Run via:  blender --python <repo>/blender/dev_register.py
# (dev.sh / dev.bat do this for you and also set MAXJS_WEB_DIR.)

import importlib
import os
import sys

import bpy

# .../maxjs/blender  — the directory that contains the maxjs_blender package.
_ADDON_PARENT = os.path.dirname(os.path.abspath(__file__))
if _ADDON_PARENT not in sys.path:
    sys.path.insert(0, _ADDON_PARENT)

import maxjs_blender  # noqa: E402

# Reload every submodule so re-running this script in a live session (Blender
# Text Editor ▶ Run, or `Reload Scripts`) picks up edits without a restart.
for _name in [n for n in sys.modules if n == "maxjs_blender" or n.startswith("maxjs_blender.")]:
    try:
        importlib.reload(sys.modules[_name])
    except Exception as _ex:  # noqa: BLE001
        print("[max.js dev] reload skipped:", _name, repr(_ex))

try:
    maxjs_blender.unregister()
except Exception:
    pass
maxjs_blender.register()

print("[max.js dev] add-on registered from repo:", _ADDON_PARENT)
print("[max.js dev] web/ ->", os.environ.get("MAXJS_WEB_DIR") or "(auto-detect ../web)")
