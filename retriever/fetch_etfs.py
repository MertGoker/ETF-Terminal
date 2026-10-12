#!/usr/bin/env python3
"""
ETF price retriever for the US and Turkish (Borsa Istanbul) ETF markets.

Source: Yahoo Finance's public chart endpoint. No API key, no account, no
paid tier -- it is the same endpoint the finance.yahoo.com charts call.

The smallest step the dashboard offers is one day, so only one *base*
resolution is stored:

    1d   from --history-start to today -> feeds 1D, 3D, 1W, 2W, 3W, 1M, 3M, 6M, 1Y

Everything coarser is resampled in the browser. Hourly bars are still
retrieved for Borsa Istanbul funds, because the feed publishes no daily
series for them at all and their daily bars have to be aggregated from the
hourly one -- but the hourly series is dropped before writing, so it never
reaches the payload.

Output layout (static, host-anywhere):

    web/data/manifest.json      index + summary stats for both markets
    web/data/us/<SYM>.json      one file per ETF, columnar OHLCV
    web/data/tr/<SYM>.json

Usage:
    python fetch_etfs.py                       # both markets, defaults
    python fetch_etfs.py --markets US
    python fetch_etfs.py --only SPY QQQ GLD
    python fetch_etfs.py --probe-candidates    # also test extra BIST tickers
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import random
import sys
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from resample import ensure_daily  # noqa: E402
from universe import (  # noqa: E402
    CATEGORY_FALLBACK,
    TR_CANDIDATES,
    TR_ETFS,
    US_ETFS,
    category_map,
)

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

# interval -> range string accepted by Yahoo for that interval
BASE_SERIES = [
    ("1h", "730d"),   # Yahoo's maximum window for hourly bars
    ("1d", None),     # explicit period1/period2 instead
]

# 2026 year-to-date is what the assignment asks the dashboard to default to.
YTD_ANCHOR = datetime(2026, 1, 1, tzinfo=timezone.utc)

# Set from --store-intraday; the hourly series is dropped from the payload
# unless this is on.
STORE_INTRADAY = False


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
_OPENER = None
_OPENER_LOCK = __import__("threading").Lock()


def opener():
    """Shared cookie-carrying opener. Yahoo throttles cookieless clients hard."""
    global _OPENER
    with _OPENER_LOCK:
        if _OPENER is None:
            import http.cookiejar
            jar = http.cookiejar.CookieJar()
            _OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            try:  # prime consent/session cookies; harmless if it fails
                req = urllib.request.Request(
                    "https://finance.yahoo.com/quote/SPY/",
                    headers={"User-Agent": USER_AGENT,
                             "Accept": "text/html,application/xhtml+xml"},
                )
                _OPENER.open(req, timeout=12).read(4096)
            except Exception:
                pass
        return _OPENER


def http_json(url: str, tries: int = 6, timeout: int = 30):
    """GET JSON with exponential backoff. Returns None once retries run out."""
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "application/json",
                          "Accept-Language": "en-US,en;q=0.9",
                          "Referer": "https://finance.yahoo.com/"}
        )
        try:
            with opener().open(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 404:
                return None  # symbol does not exist; no point retrying
            if exc.code in (429, 999, 502, 503):
                # Yahoo's throttle is IP-wide and sticky; back off generously.
                time.sleep(min(90, 8.0 * (2 ** attempt)) + random.random() * 3)
                continue
            time.sleep(1.5 * (attempt + 1))
        except Exception as exc:  # timeouts, DNS blips, truncated bodies
            last = exc
            time.sleep(2.0 * (attempt + 1) + random.random())
    if last is not None:
        print(f"    ! give up: {url.split('/')[-1][:40]} ({last})", file=sys.stderr)
    return None


def chart(symbol: str, interval: str, rng: str | None, start_ts: int | None):
    params = {
        "interval": interval,
        "includePrePost": "false",
        "events": "div,split",
    }
    if rng:
        params["range"] = rng
    else:
        params["period1"] = str(start_ts)
        params["period2"] = str(int(time.time()))
    url = CHART_URL.format(symbol=urllib.parse.quote(symbol)) + "?" + urllib.parse.urlencode(params)
    return http_json(url)


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------
def parse_series(payload) -> tuple[dict | None, dict | None]:
    """Yahoo chart payload -> (columnar OHLCV dict, meta dict)."""
    if not payload:
        return None, None
    chart_block = payload.get("chart") or {}
    results = chart_block.get("result") or []
    if not results:
        return None, None
    res = results[0]
    meta = res.get("meta") or {}
    stamps = res.get("timestamp") or []
    quotes = ((res.get("indicators") or {}).get("quote") or [{}])[0]

    opens = quotes.get("open") or []
    highs = quotes.get("high") or []
    lows = quotes.get("low") or []
    closes = quotes.get("close") or []
    vols = quotes.get("volume") or []

    t, o, h, l, c, v = [], [], [], [], [], []
    for i, ts in enumerate(stamps):
        def at(seq):
            return seq[i] if i < len(seq) else None

        co = at(closes)
        if co is None:
            continue  # Yahoo pads holidays/halts with nulls
        oo, hh, ll = at(opens), at(highs), at(lows)
        oo = co if oo is None else oo
        hh = max(oo, co) if hh is None else hh
        ll = min(oo, co) if ll is None else ll
        vv = at(vols) or 0

        t.append(int(ts))
        o.append(round(float(oo), 6))
        h.append(round(float(hh), 6))
        l.append(round(float(ll), 6))
        c.append(round(float(co), 6))
        v.append(int(vv))

    if not t:
        return None, meta
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": v}, meta


def pct(new: float, old: float):
    if old in (None, 0) or new is None:
        return None
    return round((new / old - 1.0) * 100.0, 4)


def detect_break(stamps, closes, factor: float = 10.0):
    """Find a single-session jump too large to be a price move.

    Several dozen Turkish funds step from ~4.20 to ~0.0022 on one date --
    a money market fund cannot lose 99.9% in a day, and the same break
    lands on the same date across unrelated funds, so it is a reporting
    change at the source (a redenomination or a feed error), not a return.

    The break is reported, never repaired: rescaling by the observed ratio
    would be inventing a corporate action nobody confirmed. Flagged funds
    are excluded from theme aggregates and marked in the dashboard.
    """
    worst = None
    for i in range(1, len(closes)):
        prev, cur = closes[i - 1], closes[i]
        if prev <= 0 or cur <= 0:
            continue
        ratio = cur / prev
        if ratio < 1 / factor or ratio > factor:
            if worst is None or abs(math.log(ratio)) > abs(math.log(worst["ratio"])):
                worst = {
                    "date": datetime.fromtimestamp(stamps[i], timezone.utc).strftime("%Y-%m-%d"),
                    "ratio": round(ratio, 8),
                }
    return worst


def summarise(daily: dict, meta: dict, price_type: str = "market") -> dict:
    """Headline stats for the market list, computed from the daily series."""
    closes, stamps, vols = daily["c"], daily["t"], daily["v"]
    last = closes[-1]
    prev = closes[-2] if len(closes) > 1 else None

    ytd_anchor_ts = int(YTD_ANCHOR.timestamp())
    ytd_base = None
    for ts, close in zip(stamps, closes):
        if ts >= ytd_anchor_ts:
            ytd_base = close
            break

    window = [(ts, cl) for ts, cl in zip(stamps, closes) if ts >= stamps[-1] - 365 * 86400]
    win_closes = [cl for _, cl in window] or closes

    brk = detect_break(stamps, closes)

    # Second failure mode: no single cliff, just a slide to a price no real
    # fund quotes (BDI runs 0.577 -> 0.000004 over weeks). Only applied to
    # TEFAS net asset values -- an open-ended fund is wound up long before it
    # loses 90% of its NAV, whereas a 2x leveraged ETF decaying 95% is doing
    # exactly what it says on the tin.
    if brk is None and price_type == "nav":
        peak = max(closes)
        if peak > 0 and last / peak < 0.10:
            brk = {"date": None, "ratio": round(last / peak, 8), "kind": "collapse"}

    return {
        "last": round(last, 4),
        "chgPct": pct(last, prev),
        **({"priceBreak": brk, "suspect": True} if brk else {}),
        "ytdPct": pct(last, ytd_base),
        "high52": round(max(win_closes), 4),
        "low52": round(min(win_closes), 4),
        "avgVol": int(sum(vols[-30:]) / max(1, len(vols[-30:]))),
        "bars": len(closes),
        "firstDate": datetime.fromtimestamp(stamps[0], timezone.utc).strftime("%Y-%m-%d"),
        "lastDate": datetime.fromtimestamp(stamps[-1], timezone.utc).strftime("%Y-%m-%d"),
        # Sparkline for the list view. It is drawn 46px wide, so 60 points
        # were never distinguishable -- and across a few thousand funds the
        # sparkline was roughly half the manifest. 24 reads the same.
        "spark": [round(x, 4) for x in closes[-24:]],
        "fiftyTwoWeekHigh": meta.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow": meta.get("fiftyTwoWeekLow"),
    }


# --------------------------------------------------------------------------
# Per-symbol worker
# --------------------------------------------------------------------------
def existing_record(out_dir: str, market: str, display: str):
    path = os.path.join(out_dir, "us" if market == "US" else "tr", display + ".json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def fetch_symbol(symbol: str, market: str, category: str, history_start: datetime,
                 wanted: list[str], out_dir: str, refresh: bool, pause: float):
    start_ts = int(history_start.timestamp())
    display = symbol.replace(".IS", "")

    # Resume: keep whatever a previous pass already stored for this ETF.
    prior = None if refresh else existing_record(out_dir, market, display)
    series: dict[str, dict] = dict((prior or {}).get("series") or {})
    meta: dict = dict((prior or {}).get("_meta") or {})

    todo = [(i, r) for i, r in BASE_SERIES if i in wanted and (refresh or i not in series)]
    for interval, rng in todo:
        payload = chart(symbol, interval, rng, None if rng else start_ts)
        parsed, m = parse_series(payload)
        if m:
            meta = m or meta
        if parsed:
            series[interval] = parsed
        time.sleep(pause + random.random() * pause)  # be polite

    itype = (meta.get("instrumentType") or "").upper()
    if itype and itype != "ETF":
        return symbol, None, f"{itype}, not an ETF"

    # Borsa Istanbul funds return an hourly series but only a stub daily one.
    daily_src = ensure_daily(series, meta.get("gmtoffset") if meta else
                             (prior or {}).get("gmtoffset"))
    if daily_src is None or "1d" not in series:
        return symbol, None, "no usable price history"

    if not todo and prior:
        return symbol, prior, None  # already complete, nothing refetched

    name = (meta.get("longName") or meta.get("shortName")
            or (prior or {}).get("name") or symbol)
    record = {
        "symbol": symbol,
        "display": display,
        "name": name,
        "market": market,
        "category": category or CATEGORY_FALLBACK,
        "currency": meta.get("currency") or ("TRY" if market == "TR" else "USD"),
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName")
                    or (prior or {}).get("exchange"),
        "timezone": meta.get("exchangeTimezoneName") or (prior or {}).get("timezone"),
        "gmtoffset": meta.get("gmtoffset") if meta.get("gmtoffset") is not None
                     else (prior or {}).get("gmtoffset"),
        "instrumentType": meta.get("instrumentType") or (prior or {}).get("instrumentType"),
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dailySource": daily_src,
        "baseIntervals": [i for i, _ in BASE_SERIES if i in series],
        "series": series,
        "_meta": {k: meta.get(k) for k in
                  ("currency", "longName", "shortName", "fullExchangeName", "exchangeName",
                   "exchangeTimezoneName", "gmtoffset", "instrumentType",
                   "fiftyTwoWeekHigh", "fiftyTwoWeekLow") if meta.get(k) is not None},
    }
    if not STORE_INTRADAY:
        # Hourly was only ever a means to a daily series for BIST funds.
        record["series"] = {"1d": series["1d"]}
        record["baseIntervals"] = ["1d"]

    record["stats"] = summarise(series["1d"], meta)
    return symbol, record, None


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------
def build(markets, out_dir, history_start, workers, only, probe_candidates,
          intervals, refresh, pause):
    cats = category_map()
    jobs: list[tuple[str, str, str]] = []

    if "US" in markets:
        jobs += [(s, "US", c) for s, c in US_ETFS]
    if "TR" in markets:
        jobs += [(s, "TR", c) for s, c in TR_ETFS]
        if probe_candidates:
            known = {s for s, _ in TR_ETFS}
            jobs += [(s, "TR", CATEGORY_FALLBACK) for s in TR_CANDIDATES if s not in known]

    if only:
        want = {o.upper() for o in only}
        jobs = [j for j in jobs if j[0].upper() in want or j[0].replace(".IS", "").upper() in want]

    print(f"-> {len(jobs)} symbols | markets={','.join(sorted(markets))} "
          f"| intervals={','.join(intervals)} | daily history from {history_start:%Y-%m-%d} "
          f"| {workers} workers{' | REFRESH' if refresh else ' | resume'}")

    _run(jobs, out_dir, history_start, workers, intervals, refresh, pause)


def _run(jobs, out_dir, history_start, workers, intervals, refresh, pause):
    os.makedirs(os.path.join(out_dir, "us"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "tr"), exist_ok=True)

    records: dict[str, dict] = {}
    skipped: list[tuple[str, str]] = []
    done = 0

    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        pending = {
            pool.submit(fetch_symbol, s, m, c, history_start,
                        intervals, out_dir, refresh, pause): s
            for s, m, c in jobs
        }
        for fut in futures.as_completed(pending):
            done += 1
            symbol = pending[fut]
            try:
                sym, record, err = fut.result()
            except Exception as exc:
                skipped.append((symbol, f"crash: {exc}"))
                continue
            if record is None:
                skipped.append((sym, err or "unknown"))
                print(f"[{done:>3}/{len(jobs)}] skip {sym:<10} ({err})")
                continue

            folder = "us" if record["market"] == "US" else "tr"
            path = os.path.join(out_dir, folder, f"{record['display']}.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(record, fh, separators=(",", ":"), ensure_ascii=False)
            records[sym] = record
            kb = os.path.getsize(path) / 1024
            res = "/".join(record["baseIntervals"])
            print(f"[{done:>3}/{len(jobs)}] ok   {record['display']:<10} "
                  f"{record['stats']['bars']:>5} daily  {kb:7.1f} KB  [{res}]")

    write_manifest(load_all(out_dir, records), out_dir, history_start, skipped)
    print(f"\n-> {len(records)} ETFs stored, {len(skipped)} skipped")
    if skipped:
        print("   skipped: " + ", ".join(s for s, _ in sorted(skipped)))


def load_all(out_dir, fresh):
    """Union of ETFs just fetched and ETFs already on disk from earlier passes."""
    merged = {f"{'us' if r.get('market') == 'US' else 'tr'}:{r.get('display')}": r
              for r in fresh.values()}
    for folder in ("us", "tr"):
        d = os.path.join(out_dir, folder)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, fn), encoding="utf-8") as fh:
                    rec = json.load(fh)
            except Exception:
                continue
            # key on market + file name: symbols are not globally unique
            # across venues, and a collision must never drop a fund.
            key = f"{folder}:{fn[:-5]}"
            merged.setdefault(key, rec)
    return merged


def build_from_universe(path, limit, out_dir, history_start, workers,
                        intervals, refresh, pause):
    """Retrieve a universe file produced by us_universe.py or tefas.py.

    This is the route for the full market: `us_universe.py` enumerates every
    US-listed ETF (~5,700), far more than universe.py's curated shortlist.
    Everything else -- resume, the non-ETF guard, manifest rebuilding -- works
    exactly as it does for the curated path.
    """
    with open(path, encoding="utf-8") as fh:
        uni = json.load(fh)
    items = uni.get("etfs") or uni.get("funds") or []
    jobs = []
    for it in items:
        sym = it.get("symbol") or it.get("ticker")
        if not sym:
            continue
        market = "TR" if sym.endswith(".IS") else "US"
        jobs.append((sym, market, it.get("category") or CATEGORY_FALLBACK))
    if limit:
        jobs = jobs[:limit]

    print(f"-> universe {os.path.basename(path)}: {len(jobs)} symbols "
          f"| intervals={','.join(intervals)} | {workers} workers")
    _run(jobs, out_dir, history_start, workers, intervals, refresh, pause)


# A 24-point sparkline as JSON floats costs ~170 bytes per fund; across four
# thousand funds that alone was most of the index. The chart only needs the
# shape, so each point is quantised to one character.
SPARK_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def encode_spark(values):
    vals = [v for v in (values or []) if v is not None]
    if len(vals) < 2:
        return ""
    lo, hi = min(vals), max(vals)
    rng = (hi - lo) or 1.0
    n = len(SPARK_ALPHA) - 1
    return "".join(SPARK_ALPHA[min(n, max(0, int((v - lo) / rng * n)))] for v in vals)


def _median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else round((xs[mid - 1] + xs[mid]) / 2, 4)


def write_theme_index(rows, out_dir):
    """themes.json -- the grouping the dashboard filters by and the unit any
    cross-fund comparison works in.

    Each entry carries its members and the distribution of their returns, so a
    theme can be ranked or compared without opening several thousand files.
    `Unclassified` is deliberately named: it is the residue of the name-based
    rules, not a strategy, and should be excluded from comparisons.
    """
    index: dict[str, dict] = {}
    for market, items in rows.items():
        for e in items:
            key = f"{market}:{e['h']}"
            t = index.setdefault(key, {
                "theme": e["h"], "category": e["c"], "market": market,
                "members": [], "_ytd": [], "_chg": [],
            })
            t["members"].append(e["d"])
            if e.get("x"):
                t["flagged"] = t.get("flagged", 0) + 1
                continue          # a reporting break is not a return
            t["_ytd"].append(e.get("y"))
            t["_chg"].append(e.get("p"))

    out = []
    for t in index.values():
        ytd = [x for x in t.pop("_ytd") if x is not None]
        chg = [x for x in t.pop("_chg") if x is not None]
        t["members"].sort()
        t["count"] = len(t["members"])
        t["flagged"] = t.get("flagged", 0)
        t["medianYtdPct"] = _median(ytd)
        t["medianChgPct"] = _median(chg)
        t["bestYtdPct"] = round(max(ytd), 4) if ytd else None
        t["worstYtdPct"] = round(min(ytd), 4) if ytd else None
        out.append(t)
    out.sort(key=lambda t: (t["market"], -t["count"]))

    path = os.path.join(out_dir, "themes.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "themes": out}, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"-> themes.json: {len(out)} themes ({os.path.getsize(path)/1024:.1f} KB)")


def write_manifest(records, out_dir, history_start, skipped):
    markets: dict[str, dict] = {}
    labels = {
        "US": {"label": "United States", "flag": "US", "currency": "USD",
               "symbol": "$", "venue": "NYSE Arca / Nasdaq / Cboe BZX",
               "tz": "America/New_York"},
        "TR": {"label": "Türkiye", "flag": "TR", "currency": "TRY",
               "symbol": "₺", "venue": "Borsa İstanbul BYF + TEFAS",
               "tz": "Europe/Istanbul"},
    }

    # The index is split in two so opening the page downloads only what the
    # first screen needs: a few kilobytes of market metadata, then the rows
    # for the one market on display. Every field the instrument panel reads
    # lives in the per-fund file, so a row here carries only what the list
    # itself draws -- short keys, and the sparkline as a quantised string.
    rows: dict[str, list] = {}
    for rec in records.values():
        st = rec["stats"]
        rows.setdefault(rec["market"], []).append({
            "s": rec["symbol"],
            "d": rec["display"],
            "n": rec["name"],
            "c": rec["category"],
            "h": rec.get("theme") or "Unclassified",
            "l": st.get("last"),
            "p": st.get("chgPct"),
            "y": st.get("ytdPct"),
            "k": encode_spark(st.get("spark")),
            **({"x": 1} if st.get("suspect") else {}),
        })

    for market, items in rows.items():
        items.sort(key=lambda e: e["d"])
        markets[market] = {
            **labels[market],
            "count": len(items),
            "categories": sorted({e["c"] for e in items}),
            "themes": sorted({e["h"] for e in items}),
            "themesByCategory": {
                cat: sorted({e["h"] for e in items if e["c"] == cat})
                for cat in sorted({e["c"] for e in items})
            },
            "rows": f"market-{market.lower()}.json",
        }
        path = os.path.join(out_dir, f"market-{market.lower()}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(items, fh, separators=(",", ":"), ensure_ascii=False)
        print(f"-> {os.path.basename(path)}: {len(items)} funds "
              f"({os.path.getsize(path)/1024:.1f} KB)")

    write_theme_index(rows, out_dir)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Yahoo Finance (US) and TEFAS (Türkiye), both keyless",
        "historyStart": history_start.strftime("%Y-%m-%d"),
        "defaultRangeStart": YTD_ANCHOR.strftime("%Y-%m-%d"),
        "sparkAlphabet": SPARK_ALPHA,
        "markets": markets,
        "skipped": [{"symbol": s, "reason": r} for s, r in sorted(skipped)],
    }
    path = os.path.join(out_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"-> manifest: {os.path.getsize(path)/1024:.1f} KB (index only)")


def main():
    default_out = os.path.normpath(os.path.join(HERE, "..", "web", "data"))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--markets", nargs="+", default=["US", "TR"],
                    choices=["US", "TR"], help="markets to retrieve")
    ap.add_argument("--out", default=default_out, help="output data directory")
    ap.add_argument("--history-start", default="2021-01-01",
                    help="first date for the daily series (default 2021-01-01)")
    ap.add_argument("--store-intraday", action="store_true",
                    help="also keep the hourly series in the output (off by default: "
                         "the dashboard's smallest step is one day)")
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--only", nargs="*", default=None, help="restrict to these tickers")
    ap.add_argument("--probe-candidates", action="store_true",
                    help="also try the extra Borsa Istanbul tickers in universe.TR_CANDIDATES")
    ap.add_argument("--intervals", nargs="+", default=[i for i, _ in BASE_SERIES],
                    choices=[i for i, _ in BASE_SERIES],
                    help="which base resolutions to retrieve this pass "
                         "(run '--intervals 1d' first for a fast usable dataset)")
    ap.add_argument("--refresh", action="store_true",
                    help="refetch intervals already stored instead of resuming")
    ap.add_argument("--pause", type=float, default=0.3,
                    help="base delay between requests, seconds (raise if throttled)")
    ap.add_argument("--rebuild-manifest", action="store_true",
                    help="only regenerate manifest.json from the files already on disk")
    ap.add_argument("--universe", default=None,
                    help="JSON file from us_universe.py / tefas.py to retrieve instead of "
                         "the hand-curated lists in universe.py")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap how many symbols from --universe to retrieve")
    args = ap.parse_args()

    global STORE_INTRADAY
    STORE_INTRADAY = args.store_intraday
    start = datetime.strptime(args.history_start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if args.rebuild_manifest:
        write_manifest(load_all(args.out, {}), args.out, start, [])
        return
    if args.universe:
        build_from_universe(args.universe, args.limit, args.out, start, args.workers,
                            args.intervals, args.refresh, args.pause)
        return
    build(set(args.markets), args.out, start, args.workers, args.only,
          args.probe_candidates, args.intervals, args.refresh, args.pause)


if __name__ == "__main__":
    main()
