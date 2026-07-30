# max.js Host Contract — v1

The `web/` runtime is host-agnostic. A **host** is whatever embeds or serves the
editor and feeds it a scene: the 3ds Max C++ plugin (WebView2), the Blender
add-on (`maxjs-blender/maxjs_blender/webview2_shim.js` + SSE pump), or a future
standalone app. This file is the contract between them; the only web-side code
that touches it is `web/js/editor/host_bridge.js`. Nothing else in `web/` may
reference `window.chrome.webview`.

Version: `HOST_CONTRACT_VERSION = 1` (exported by `host_bridge.js`). The viewer
stamps it into the ready handshake as `contractVersion`; hosts that care can
assert it. Additive changes (new message types, new optional fields) do NOT
bump the version. Renames, removals, or semantic changes DO — and should be
extraordinarily rare.

## What a host must provide

`window.chrome.webview` must exist **before** the index.html `<head>` bootstrap
runs (it redirects to the standalone snapshot viewer when absent), with:

| Member | Purpose |
|---|---|
| `addEventListener('message', fn)` | JSON control messages host → viewer; `fn({data})`, `data` is the parsed message object with a `type` field |
| `addEventListener('sharedbufferreceived', fn)` | binary payloads host → viewer; `fn(e)` where `e.getBuffer()` → ArrayBuffer and `e.additionalData` → meta (object or JSON string with a `type` field) |
| `postMessage(obj)` | viewer → host; always a `{type, ...}` object |
| `releaseBuffer(buf)` | called after every shared-buffer handler; may be a no-op |
| `postMessageWithAdditionalObjects(...)` | may be a no-op |

Optionally, a host may also define `window.MAXJS_HOST_PROFILE` (before the
`<head>` bootstrap, same as `chrome.webview`) to rebrand host terminology in
the UI: `{ app, appFull, sceneExt }` — e.g. the Blender shim sends
`{ app: 'Blender', appFull: 'Blender', sceneExt: '.blend' }`. Every field is
optional; defaults are the 3ds Max reference host (`Max` / `3ds Max` /
`.max`), read via `web/js/host_profile.js`. Terminology only — never a
behavior branch.

## Handshake

1. Host loads `web/index.html` with the API above in place.
2. Viewer finishes booting and posts `{type:'ready', contractVersion:1}`,
   retrying every 1 s until the first scene payload arrives.
3. Host responds with a full scene: a `scene_bin` shared buffer (snapshot.json
   meta + scene.bin payload) — this stops the retry loop.
4. Thereafter the host streams deltas (`delta_bin`, `geo_fast`, `xform`,
   `cam`, ...) as the scene changes.

## Binary shared-buffer payloads (`meta.type`)

| type | Content |
|---|---|
| *(none / anything else)* | full scene: meta = snapshot.json object, buffer = scene.bin |
| `delta_bin` | MXJB delta frame |
| `geo_fast` | real-time vertex/topology update for one node (`meta.h` = handle; offsets `vOff/vN`, `iOff/iN`, `uvOff/uvN`, `nOff/nN`, vertex colors `vc`, `groups`, `skipBounds`, `compactChannels`, `jsmod`, `spline`) |
| `gi_surface_bin` | native GI surface samples (`floatCount`, `sampleCount`, `boundsMin`, `boundsSize`) |
| `gi_light_bin` | native GI light table (`floatCount`, `lightCount`) |

## JSON control messages, host → viewer (`bridge.on`)

`audio_update`, `cam`, `clay_mode`, `debug`, `env_update`, `geo_fast` (JSON
variant), `gltf_update`, `hair_fast`, `host_action_result`,
`inline_layers_state`, `live_sync_settings`, `pathtracing_settings`,
`probeGrids`, `project_config`, `project_reload`,
`render_css3d_mask_begin`, `render_css3d_mask_end`, `render_output_settings`,
`render_sequence_done`, `render_sequence_frame`, `render_to_image`,
`render_to_image_done`, `scene`, `snapshot_export_request`, `webapp_update`,
`xform`.

A host only has to send what it supports — the viewer treats every type as
optional.

`project_config` configures the scene-local project runtime:
`{dir, inlineDir, pollMs, sceneSaved, manifestExists, rootUrl?}`. `rootUrl`
is optional: when present, the viewer fetches/imports project files
(`project.maxjs.json`, `settings.maxjs.json`, `postfx.maxjs.json`,
`inlines/*.js`) from that base URL (resolved against the page URL) instead of
deriving `https://maxjs-assets.local/...` from `dir`. Hosts that serve the
project directory over HTTP themselves (the Blender add-on) send it; the
3ds Max WebView2 host omits it and keeps the virtual-host mapping.
`inline_layers_state` is the host's full scan of `inlines/`:
`{stamp, layers:[{key, id, name, folder, stamp, priority, enabled}]}`.

## JSON control messages, viewer → host (`postMessage`)

`ready`, `gi_probe_refresh`, `gpu_normals`, `kill`, `live_sync_settings`,
`lock_camera`, `pathtracing_settings`, `refresh`, `render_css3d_mask_ready`,
`render_to_image_ready`, `scene_dirty`, `snapshot_export`, `snapshot_serve`,
`sync_lightmap_uvs`, `webapp_set`.

Hosts may ignore any of these. Request/response pairs use `requestHostAction`:
the viewer sends `{type: action, requestId, ...}` and expects
`{type:'host_action_result', requestId, action, ok, ...}` back within the
timeout (60 s default; 10 s for the project runtime's own actions). Used for
`snapshot_analyze`, `bake_proxy_image_write`, and the project runtime actions:
`project_release_manifest` (result may carry `path` and optional `rootUrl`),
`project_manifest_write`, `project_postfx_write`, `project_settings_write`,
`inline_layer_remove`, `inline_layer_set_enabled`, `inline_layer_clear`.

## Rules

- New host integrations must work by **providing this surface only** — never by
  editing core `web/` files. (The Blender shim is the reference implementation
  of a fake host; `tools/split_smoke_shim.js` is the minimal one.)
- Web-side, all host access goes through `createHostBridge()`; subsystems
  register `bridge.on(...)` / `hostBridge.onSharedBuffer(...)` handlers and
  never touch `window.chrome.webview` directly.
- The 3ds Max C++ plugin is the reference host; when it gains a message type,
  add it to this file in the same change.
