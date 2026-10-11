#!/usr/bin/env python3
"""
Turn a browser-assisted capture into the dashboard's data files.

`fetch_etfs.py` is the normal path. When the provider throttles cookieless
clients (HTTP 429 for every server-side request), `pull.html` collects the
same chart payloads from a real browser session and drops one bundle into
`raw/bundle.json`; this script normalises that bundle into exactly the files
`fetch_etfs.py` would have written, then rebuilds the manifest.

    python3 build_from_raw.py [raw/bundle.json]
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from fetch_etfs import YTD_ANCHOR, summarise, write_manifest  # noqa: E402
from resample import compact, ensure_daily  # noqa: E402
from universe import CATEGORY_FALLBACK, category_map  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, "..", "web", "data"))
ORDER = ["1h", "1d"]

# Hourly bars exist for 730 days but the intraday steps (1h-8h) are only ever
# read over short windows, so shipping the whole two years roughly triples the
# payload for bars nobody charts. Daily history is kept in full.
HOURLY_DAYS = 400
DAILY_DAYS = None


def columnar(entry):
    """Compact capture -> the same columnar OHLCV shape fetch_etfs writes."""
    t, o, h, l, c, v = [], [], [], [], [], []
    stamps = entry["t"]
    for i, ts in enumerate(stamps):
        def at(key):
            seq = entry.get(key) or []
            return seq[i] if i < len(seq) else None

        close = at("c")
        if close is None:
            continue                     # provider pads halts/holidays with nulls
        op, hi, lo = at("o"), at("h"), at("l")
        op = close if op is None else op
        hi = max(op, close) if hi is None else hi
        lo = min(op, close) if lo is None else lo

        t.append(int(ts))
        o.append(round(float(op), 6))
        h.append(round(float(hi), 6))
        l.append(round(float(lo), 6))
        c.append(round(float(close), 6))
        v.append(int(at("v") or 0))

    if not t:
        return None
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": v}


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "raw", "bundle.json")
    blob = open(path, encoding="utf-8").read()
    if blob.startswith("b="):            # text/plain form encoding from pull.html
        blob = blob[2:]
    entries = json.loads(blob)
    print(f"-> {len(entries)} captured series from {os.path.basename(path)}")

    cats = category_map()
    grouped: dict[str, dict] = {}
    for e in entries:
        grouped.setdefault(e["sym"], {"meta": {}, "series": {}})
        series = columnar(e)
        if series:
            grouped[e["sym"]]["series"][e["iv"]] = series
        grouped[e["sym"]]["meta"].update(e.get("meta") or {})

    os.makedirs(os.path.join(OUT, "us"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "tr"), exist_ok=True)

    records = {}
    for symbol, g in sorted(grouped.items()):
        series, meta = g["series"], g["meta"]
        # Borsa Istanbul funds come back with an hourly series but only a stub
        # daily one, so aggregate the daily bars ourselves when needed.
        daily_src = ensure_daily(series, meta.get("gmtoffset"))
        if daily_src is None or "1d" not in series:
            print(f"   skip {symbol}: no usable price history")
            continue
        market = "TR" if symbol.endswith(".IS") else "US"
        display = symbol.replace(".IS", "")
        rec = {
            "symbol": symbol,
            "display": display,
            "name": meta.get("longName") or meta.get("shortName") or symbol,
            "market": market,
            "category": cats.get(symbol, CATEGORY_FALLBACK),
            "currency": meta.get("currency") or ("TRY" if market == "TR" else "USD"),
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
            "timezone": meta.get("exchangeTimezoneName"),
            "gmtoffset": meta.get("gmtoffset"),
            "instrumentType": meta.get("instrumentType"),
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "dailySource": daily_src,
            "baseIntervals": [i for i in ORDER if i in series],
            "series": {i: compact(series[i], HOURLY_DAYS if i == "1h" else DAILY_DAYS)
                       for i in ORDER if i in series},
        }
        rec["stats"] = summarise(series["1d"], meta)
        folder = "us" if market == "US" else "tr"
        dest = os.path.join(OUT, folder, display + ".json")
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, separators=(",", ":"), ensure_ascii=False)
        records[symbol] = rec
        kb = os.path.getsize(dest) / 1024
        tag = "" if daily_src == "feed" else "  (daily aggregated from 1h)"
        print(f"   ok {display:<8} {market}  "
              f"{len(series['1d']['t']):>5}d {len(series.get('1h', {}).get('t', [])):>5}h  "
              f"{kb:7.1f} KB{tag}")

    write_manifest(records, OUT, YTD_ANCHOR, [])
    print(f"-> {len(records)} ETFs written to {OUT}")


if __name__ == "__main__":
    main()
