# server.py — overlay HTTP server for previewing a Blender export in the
# SHARED max.js web/ runtime.
#
# Translation-layer mechanism: this server roots at the repo's live `web/`
# directory and overlays only the generated snapshot files (snapshot.json,
# scene.bin, project sidecars). Because the runtime is served BY REFERENCE,
# every future improvement to max.js's web side (GI, post-FX, Layer Manager,
# the snapshot loader itself) appears in the Blender preview automatically —
# nothing here is forked.

import http.server
import os
import posixpath
import threading
import urllib.parse

_CONF = {"web_root": None, "export_dir": None}
_SERVER = {"httpd": None, "thread": None, "port": None}


class _OverlayHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        rel = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        export_dir = _CONF["export_dir"]
        web_root = _CONF["web_root"]
        if export_dir:
            cand = os.path.join(export_dir, rel.replace("/", os.sep))
            if os.path.isfile(cand):
                return cand
        return os.path.join(web_root, rel.replace("/", os.sep))

    def end_headers(self):
        # Snapshots fetch with cache: 'no-store'; mirror that for re-exports.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # keep Blender's console quiet


def serve(web_root, export_dir, port=0):
    """Start (or reuse) the overlay server. Returns (httpd, port).

    Re-exports only update _CONF, so the same server keeps serving the newest
    snapshot without rebinding the port.
    """
    _CONF["web_root"] = os.path.abspath(web_root)
    _CONF["export_dir"] = os.path.abspath(export_dir)

    if _SERVER["httpd"] is not None:
        return _SERVER["httpd"], _SERVER["port"]

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", int(port or 0)), _OverlayHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    _SERVER.update(httpd=httpd, thread=thread, port=httpd.server_address[1])
    return httpd, _SERVER["port"]


def stop():
    if _SERVER["httpd"] is not None:
        try:
            _SERVER["httpd"].shutdown()
            _SERVER["httpd"].server_close()
        finally:
            _SERVER.update(httpd=None, thread=None, port=None)
