#!/usr/bin/env python3
"""
serve.py — static server for MAIGO-CHAN.

Plain `python3 -m http.server` is enough on a desktop, but it is not enough
inside an embedded/sandboxed preview iframe:

  * module scripts are fetched in CORS mode, and a sandboxed document has an
    opaque origin, so the response needs `Access-Control-Allow-Origin`
  * a few systems map `.js` to `application/octet-stream`, and the browser then
    refuses to execute the module ("Expected a JavaScript module script")
  * a cached index.html from an earlier run hides every fix you just made

So: correct MIME types, permissive CORS, and no-store on everything.

Note on compression: an earlier revision gzipped responses here. It is a real
win on paper (the avatar drops from 5.3 MB to 2.0 MB) but it puts every module
script behind a `Content-Encoding` header, and a proxy that re-writes or strips
that header turns main.js into an unparseable blob — the page then sits on the
title screen and reports "the game module did not load". Byte savings are not
worth a blank screen, so compression stays off and the avatar is optimised on
disk instead.
"""

import os
import sys
import mimetypes
import http.server
import socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8080"))
BIND = os.environ.get("BIND", "0.0.0.0")

for ext, mime in [
    (".js", "text/javascript"),
    (".mjs", "text/javascript"),
    (".json", "application/json"),
    (".svg", "image/svg+xml"),
    (".css", "text/css"),
    (".glb", "model/gltf-binary"),
    (".vrm", "model/gltf-binary"),
    (".wasm", "application/wasm"),
    (".mp3", "audio/mpeg"),
    (".m4a", "audio/mp4"),
    (".ogg", "audio/ogg"),
]:
    mimetypes.add_type(mime, ext)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s — %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    with Server((BIND, PORT), Handler) as httpd:
        print(f"▸ serving {ROOT} on http://{BIND}:{PORT}/  (ctrl-c to stop)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
