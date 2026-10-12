#!/usr/bin/env python3
"""
Local dev server for web/.

`python3 -m http.server` is single-threaded and never compresses, so a local
page load looks nothing like production: every request queues behind the last
one and the index downloads raw. This serves the same files threaded and
gzipped, which is what Cloudflare Pages, Vercel and Netlify all do, so the
numbers you see here are the numbers users will see.

    python3 serve.py [port]        # default 8080
"""
import gzip
import io
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
COMPRESS = (".html", ".js", ".css", ".json", ".svg", ".txt", ".map")
MIN_SIZE = 1024


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        if not os.path.isfile(path):
            return super().send_head()

        accepts = "gzip" in (self.headers.get("Accept-Encoding") or "")
        ext = os.path.splitext(path)[1].lower()
        size = os.path.getsize(path)
        if not (accepts and ext in COMPRESS and size >= MIN_SIZE):
            return super().send_head()

        with open(path, "rb") as fh:
            raw = fh.read()
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
            gz.write(raw)
        body = buf.getvalue()

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        return io.BytesIO(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"serving {ROOT} on http://127.0.0.1:{port}  (threaded, gzip)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
