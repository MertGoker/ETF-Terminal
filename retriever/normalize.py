#!/usr/bin/env python3
"""
Bring everything already in web/data up to the current storage policy.

Policy changes (smallest step, history window, rounding) would otherwise only
reach funds that happen to be re-retrieved. This rewrites what is on disk:

  * drop any stored resolution finer than the dashboard's smallest step
  * clip every series to --history-start
  * re-round prices and rebuild the manifest

    python3 normalize.py                      # apply the current policy
    python3 normalize.py --history-start 2021-01-01
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from fetch_etfs import YTD_ANCHOR, load_all, summarise, write_manifest  # noqa: E402
from classify import classify  # noqa: E402
from resample import compact, ensure_daily  # noqa: E402
from universe import category_map  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=os.path.normpath(os.path.join(HERE, "..", "web", "data")))
    ap.add_argument("--history-start", default="2021-01-01")
    ap.add_argument("--keep", nargs="+", default=["1d"], help="resolutions to keep")
    ap.add_argument("--recategorise", action="store_true",
                    help="re-derive US categories from fund names")
    args = ap.parse_args()

    start = int(datetime.strptime(args.history_start, "%Y-%m-%d")
                .replace(tzinfo=timezone.utc).timestamp())
    keep = set(args.keep)
    cats = category_map() if args.recategorise else {}
    changed = 0

    for folder in ("us", "tr"):
        d = os.path.join(args.data, folder)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".json"):
                continue
            path = os.path.join(d, fn)
            rec = json.load(open(path, encoding="utf-8"))
            series = rec.get("series") or {}
            before = os.path.getsize(path)

            # the hourly series may be the only source of daily bars (BIST)
            ensure_daily(series, rec.get("gmtoffset"))
            series = {k: v for k, v in series.items() if k in keep}
            if not series.get("1d"):
                print(f"   !! {fn}: no daily series after normalising, left alone")
                continue

            out = {}
            for k, v in series.items():
                t = v["t"]
                i = 0
                while i < len(t) and t[i] < start:
                    i += 1
                out[k] = compact({kk: vv[i:] for kk, vv in v.items()})

            if args.recategorise and rec.get("market") == "US":
                rec["category"] = cats.get(rec["symbol"]) or classify(rec.get("name") or "")
            rec["series"] = out
            rec["baseIntervals"] = [k for k in ("1h", "1d") if k in out]
            rec["stats"] = summarise(out["1d"], {})
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(rec, fh, separators=(",", ":"), ensure_ascii=False)
            after = os.path.getsize(path)
            if abs(after - before) > 64:
                changed += 1
                print(f"   {rec['display']:<8} {before/1024:7.1f} -> {after/1024:6.1f} KB  "
                      f"{len(out['1d']['t']):>5} bars")

    write_manifest(load_all(args.data, {}), args.data, YTD_ANCHOR, [])
    print(f"-> {changed} files rewritten")


if __name__ == "__main__":
    main()
