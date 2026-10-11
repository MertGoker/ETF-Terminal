#!/usr/bin/env python3
"""
Derive the Claude Artifact page from the standalone site.

`web/index.html` is a complete document so the project can be served by any
static host (Vercel, GitHub Pages, `python3 -m http.server`). The Artifact
publisher supplies its own <!doctype>/<head>/<body>, so this strips the
wrapper and keeps one source of truth for the markup.

    python3 build_artifact.py        # -> artifact/index.html
"""
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "web", "index.html")
OUT_DIR = os.path.join(HERE, "artifact")

html = open(SRC, encoding="utf-8").read()

head = re.search(r"<!-- ARTIFACT-HEAD-START -->(.*?)<!-- ARTIFACT-HEAD-END -->", html, re.S)
body = re.search(r"<body>(.*?)</body>", html, re.S)
if not head or not body:
    raise SystemExit("index.html is missing the ARTIFACT-HEAD markers or <body>")

page = head.group(1).strip() + "\n\n" + body.group(1).strip() + "\n"

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "index.html"), "w", encoding="utf-8") as fh:
    fh.write(page)

shutil.copy2(os.path.join(HERE, "web", "app.js"), os.path.join(OUT_DIR, "app.js"))
print(f"-> artifact/index.html  ({len(page)/1024:.1f} KB)")
print(f"-> artifact/app.js      ({os.path.getsize(os.path.join(OUT_DIR,'app.js'))/1024:.1f} KB)")
