#!/usr/bin/env bash
# max.js Blender dev launcher (macOS / Linux) — the dev.bat of the Blender side.
#
# Launches Blender with the add-on loaded straight from THIS repo and web/
# pointed at the repo, so your live edits / `git pull`s apply on the next launch
# with no install or copy step. Nothing is written into Blender's addons folder.
#
# Usage:   ./blender/dev.sh [scene.blend]
#   Override Blender:   BLENDER=/path/to/blender ./blender/dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../maxjs/blender
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"                          # .../maxjs

# Point the runtime at the repo's web/ (same trick dev.bat uses for Max).
export MAXJS_WEB_DIR="$REPO/web"

# Find Blender (macOS default, else PATH). Override with BLENDER=...
if [[ -n "${BLENDER:-}" ]]; then
  BL="$BLENDER"
elif [[ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]]; then
  BL="/Applications/Blender.app/Contents/MacOS/Blender"
elif command -v blender >/dev/null 2>&1; then
  BL="$(command -v blender)"
else
  echo "Blender not found. Set BLENDER=/path/to/Blender and re-run." >&2
  exit 1
fi

echo "max.js dev: $BL"
echo "  add-on: $SCRIPT_DIR/maxjs_blender (live from repo)"
echo "  web/:   $MAXJS_WEB_DIR"
exec "$BL" --python "$SCRIPT_DIR/dev_register.py" "$@"
