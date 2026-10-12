#!/usr/bin/env python3
"""
Build the US ETF universe from the Nasdaq Trader symbol directory.

Nasdaq publishes the official daily symbol file for every US-listed security,
free and without a key, and flags which ones are ETFs. That is the honest way
to enumerate the market -- roughly 5,700 ETFs -- rather than hand-listing
tickers.

    python3 us_universe.py                 # write the full list
    python3 us_universe.py --limit 2000    # cap it
    python3 us_universe.py --stats         # just count
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt"
EXCHANGE = {"A": "NYSE American", "N": "NYSE", "P": "NYSE Arca",
            "Q": "Nasdaq", "Z": "Cboe BZX", "V": "IEX"}


def fetch(timeout: int = 60) -> list[dict]:
    req = urllib.request.Request(SRC, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8", "replace")

    rows = [l.rstrip("\n").split("|") for l in text.splitlines()]
    hdr = rows[0]
    idx = {k: hdr.index(k) for k in
           ("Symbol", "Security Name", "Listing Exchange", "ETF", "Test Issue", "NextShares")}

    out = []
    for r in rows[1:]:
        if len(r) != len(hdr):
            continue                                   # trailing file-creation line
        if r[idx["ETF"]] != "Y" or r[idx["Test Issue"]] != "N":
            continue
        sym = r[idx["Symbol"]].strip()
        # Yahoo cannot resolve preferred/warrant/unit style suffixes
        if not sym or any(c in sym for c in "$. "):
            continue
        out.append({
            "symbol": sym,
            "name": r[idx["Security Name"]].strip(),
            "exchange": EXCHANGE.get(r[idx["Listing Exchange"]], r[idx["Listing Exchange"]]),
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "us_universe.json"))
    ap.add_argument("--stats", action="store_true")
    args = ap.parse_args()

    etfs = fetch()
    print(f"-> {len(etfs)} US-listed ETFs in the Nasdaq symbol directory")
    by_ex: dict[str, int] = {}
    for e in etfs:
        by_ex[e["exchange"]] = by_ex.get(e["exchange"], 0) + 1
    for k, v in sorted(by_ex.items(), key=lambda x: -x[1]):
        print(f"   {k:<14} {v}")
    if args.stats:
        return

    if args.limit:
        etfs = etfs[:args.limit]
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"count": len(etfs), "source": SRC, "etfs": etfs}, fh, ensure_ascii=False, indent=1)
    print(f"-> {len(etfs)} written to {args.out}")


if __name__ == "__main__":
    main()
