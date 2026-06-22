# max.js Blender add-on — macOS dev setup (read me, then link it)

> For a Claude/agent or human bringing the Blender add-on up on the **Mac**.
> The Windows box (`clone2k`) is where the code is authored; this Mac pulls it.

## How this repo gets here / stays current

This clone's `origin` is a **read-only `git daemon` over Tailscale** on the
Windows dev box — `git://clone2k/maxjs` (no GitHub yet, local-only by design).
To get the latest work:

```bash
git pull          # fetches whatever was just committed on clone2k
```

You can't push to this remote (read-only). That's intentional — the Mac is for
**testing the Blender side**, the authoring happens on Windows.

## Run the add-on straight from this repo (preferred — mirrors `dev.bat`)

Don't install/copy the add-on. Launch Blender pointed at the repo, so every
`git pull` applies on the next launch:

```bash
chmod +x blender/dev.sh            # once
./blender/dev.sh                   # launches Blender with the add-on + web/ live
#   BLENDER=/path/to/Blender ./blender/dev.sh   # if Blender isn't at the default
```

`dev.sh` sets `MAXJS_WEB_DIR=<repo>/web` and runs Blender with
`--python blender/dev_register.py`, which imports `maxjs_blender` from this
working copy and registers it. Then in Blender: **3D Viewport ▸ press `N` ▸
`max.js` tab ▸ Start Live IPR**. It opens the real max.js editor in the browser.

- Make **Chrome** the default browser (macOS Safari's WebGPU is patchier).
- A Mac scene needs a **camera** for sensible framing.
- Re-apply edits without restarting Blender: open `blender/dev_register.py` in
  Blender's **Text Editor ▸ Run** (it reloads all `maxjs_blender.*` and re-registers).

## Alternative — install once via symlink (persistent, shows in Preferences)

```bash
BLVER=4.2   # set to the installed Blender version (ls ~/Library/Application\ Support/Blender)
ln -s "$PWD/blender/maxjs_blender" \
  "$HOME/Library/Application Support/Blender/$BLVER/scripts/addons/maxjs_blender"
```
Then **Preferences ▸ Add-ons**, enable **max.js (Blender bridge)**. With a
symlink, `__file__` may resolve to the link location, so if `web/` isn't found,
either set the panel's **web/** field to `<repo>/web` or
`export MAXJS_WEB_DIR=<repo>/web` before launching Blender. (The `dev.sh` path
above avoids this — it always resolves `web/` to the repo.)

## Verify it works

1. `./blender/dev.sh` → Blender opens, `max.js` tab present in the N-panel.
2. **Start Live IPR** → browser opens the editor; the sample scene renders.
3. Move/rotate an object or tweak a Principled BSDF → the browser updates live
   (the HUD shows `[binary-delta]`).

## How it works (so you can debug it)

The add-on is a **translation layer**: it feeds the SAME `web/` runtime the Max
plugin drives. Only `extract_blender.py` is Blender-coupled. Live IPR pushes
**MXJB delta frames** over SSE to the real editor (`web/index.html`) via a
WebView2-host shim. Full architecture + internals: **`blender/README.md`**.

Key files: `maxjs_blender/{extract_blender,serialize,contract,pump,server,
ipr_client.js,webview2_shim.js}.py`, launcher `dev.sh` + `dev_register.py`.
