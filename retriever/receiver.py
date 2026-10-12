#!/usr/bin/env python3
"""
Local drop box for browser-assisted retrieval.

Yahoo throttles cookieless clients by IP, and once tripped every server-side
request returns 429 for a long while. This serves a page at /pull that hands
you a snippet to run in the browser console on Yahoo's own origin -- the chart
endpoint sends no CORS headers, so a collector served from here cannot fetch
it, and only same-origin code can. The snippet posts its capture back here and
`build_from_raw.py` turns it into the same JSON `fetch_etfs.py` writes.

Nothing here is needed on the happy path: `fetch_etfs.py` alone is enough
whenever the endpoint answers.

    python3 receiver.py [port]      # default 8787
    #   /          -> what has been dropped so far
    #   /symbols   -> universe symbols still missing from web/data
    #   /pull      -> the snippet + instructions
"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")
os.makedirs(RAW, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    @staticmethod
    def _missing():
        """Universe symbols that have no data file yet, so a bridge run only
        collects what is actually still needed."""
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from universe import TR_ETFS, US_ETFS

        data = os.path.normpath(os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "web", "data"))
        have = set()
        for folder in ("us", "tr"):
            d = os.path.join(data, folder)
            if os.path.isdir(d):
                have |= {f[:-5] for f in os.listdir(d) if f.endswith(".json")}
        defined = [s for s, _ in US_ETFS] + [s for s, _ in TR_ETFS]
        missing = [s for s in defined if s.replace(".IS", "") not in have]
        return {"symbols": missing, "have": len(have), "historyStartYear": 2020}

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
        # Chrome's Private Network Access check: a secure public origin may
        # only reach 127.0.0.1 if the preflight opts in explicitly.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path.startswith("/symbols"):
            body = json.dumps(self._missing()).encode()
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
            return
        if self.path.startswith("/pull"):
            page = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pull.html")
            with open(page, "rb") as fh:
                body = fh.read()
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
            return
        files = sorted(f for f in os.listdir(RAW) if f.endswith(".json"))
        body = json.dumps({"count": len(files), "files": files}).encode()
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        from urllib.parse import urlparse, parse_qs, unquote
        q = parse_qs(urlparse(self.path).query)
        name = unquote((q.get("name") or ["drop"])[0])
        safe = "".join(c for c in name if c.isalnum() or c in "._-")
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n)
        with open(os.path.join(RAW, safe + ".json"), "wb") as fh:
            fh.write(data)
        print(f"  <- {safe}.json  {len(data)/1024:7.1f} KB", flush=True)
        body = b'{"ok":true}'
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"receiver on http://127.0.0.1:{port}  ->  {RAW}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
