# server.py — overlay HTTP server + live-IPR delta transport.
#
# Translation-layer mechanism: roots at the repo's live `web/` directory and
# overlays only the generated snapshot files. The runtime is served BY
# REFERENCE, so future max.js web improvements appear automatically — nothing
# here is forked.
#
# For live IPR it also: (1) queues MXJB delta frames pushed by the Blender pump,
# (2) serves them at GET /maxjs/delta?since=N (binary, cursor-based), (3) serves
# the injected client at /maxjs/ipr_client.js, and (4) appends that client to
# served .html when IPR is active. No websockets — plain stdlib http.server poll.

import http.server
import os
import posixpath
import struct
import threading
import urllib.parse

_CONF = {"web_root": None, "export_dir": None, "ipr": False}
_SERVER = {"httpd": None, "thread": None, "port": None}

# Cursor-based delta ring. `base` = number of frames dropped; frames[0] has
# absolute index `base`. Clients poll with the absolute cursor they've consumed.
_DELTA = {"frames": [], "base": 0, "cap": 8192, "lock": threading.Lock()}

_CLIENT_TAG = b'<script type="module" src="/maxjs/ipr_client.js"></script>'


def push_delta(frame_bytes):
    with _DELTA["lock"]:
        _DELTA["frames"].append(frame_bytes)
        overflow = len(_DELTA["frames"]) - _DELTA["cap"]
        if overflow > 0:
            del _DELTA["frames"][:overflow]
            _DELTA["base"] += overflow


def _take_delta(since):
    with _DELTA["lock"]:
        base = _DELTA["base"]
        frames = _DELTA["frames"]
        start = max(0, since - base)
        out = frames[start:]
        return out, base + len(frames)


def clear_delta():
    with _DELTA["lock"]:
        _DELTA["frames"].clear()
        _DELTA["base"] = 0


def set_ipr(enabled):
    _CONF["ipr"] = bool(enabled)


class _OverlayHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        rel = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        export_dir = _CONF["export_dir"]
        if export_dir:
            cand = os.path.join(export_dir, rel.replace("/", os.sep))
            if os.path.isfile(cand):
                return cand
        return os.path.join(_CONF["web_root"], rel.replace("/", os.sep))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/maxjs/delta":
            return self._serve_delta()
        if path == "/maxjs/ipr_client.js":
            return self._serve_file(os.path.join(os.path.dirname(__file__), "ipr_client.js"),
                                    "text/javascript")
        if _CONF["ipr"]:
            fs = self.translate_path(self.path)
            if fs.lower().endswith(".html") and os.path.isfile(fs):
                return self._serve_html_injected(fs)
        return super().do_GET()

    def _serve_delta(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            since = int(qs.get("since", ["0"])[0])
        except ValueError:
            since = 0
        out, next_cursor = _take_delta(since)
        if not out:
            self.send_response(204)
            self.end_headers()
            return
        parts = [struct.pack("<II", next_cursor, len(out))]
        for fr in out:
            parts.append(struct.pack("<I", len(fr)))
            parts.append(fr)
        blob = b"".join(parts)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _serve_file(self, abspath, content_type):
        if not os.path.isfile(abspath):
            self.send_error(404)
            return
        with open(abspath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_html_injected(self, fs):
        with open(fs, "rb") as f:
            data = f.read()
        idx = data.lower().rfind(b"</body>")
        data = (data[:idx] + _CLIENT_TAG + data[idx:]) if idx != -1 else (data + _CLIENT_TAG)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def serve(web_root, export_dir, port=0, ipr=False):
    """Start (or reuse) the overlay server. Returns (httpd, port)."""
    _CONF["web_root"] = os.path.abspath(web_root)
    _CONF["export_dir"] = os.path.abspath(export_dir)
    _CONF["ipr"] = bool(ipr)

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
    clear_delta()
