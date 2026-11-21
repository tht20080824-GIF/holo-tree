#!/usr/bin/env python3
"""
极简静态服务器（带 gzip）。带宽紧张时 HTML 能省 4 倍流量。

用法： python3 tools/serve-dir.py --dir dist-cdn --port 8771
"""
import argparse
import gzip
import http.server
import mimetypes
import os
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--dir", default="dist-cdn")
parser.add_argument("--port", type=int, default=8771)
parser.add_argument("--bind", default="0.0.0.0")
args = parser.parse_args()

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), args.dir)
COMPRESSIBLE = (".html", ".js", ".css", ".json", ".svg")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        rel = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        path = os.path.join(ROOT, os.path.normpath(rel))
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not path.startswith(ROOT) or not os.path.isfile(path):
            self.send_error(404, "not found")
            return

        with open(path, "rb") as f:
            raw = f.read()

        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        body = raw
        if path.endswith(COMPRESSIBLE) and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(raw, 9)

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if body is not raw:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *a):
        sys.stderr.write("[cdn] %s\n" % (fmt % a))


print(f"serving {ROOT} on {args.bind}:{args.port}", flush=True)
http.server.ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()
