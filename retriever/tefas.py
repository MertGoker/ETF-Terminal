#!/usr/bin/env python3
"""
TEFAS — the authoritative Turkish fund universe.

TEFAS (Türkiye Elektronik Fon Alım Satım Platformu) is the official registry
for Turkish funds, so it is the right place to learn *which* funds exist and
what they are. It is used here for the universe only, not for prices:

  * `fundType=BYF` (Borsa Yatırım Fonu) is the exchange-traded fund list --
    37 funds as of October 2026, which is the real size of the Turkish ETF
    market. `fundType=YAT` returns 2,136, but those are open-ended mutual
    funds, not ETFs: they do not trade on an exchange and have no intraday
    price, only a daily NAV struck once per day.
  * TEFAS publishes a single daily NAV per fund -- never OHLC, never
    intraday, no volume. Records sourced here are marked `priceType: "nav"`
    so the dashboard can show them as a line rather than pretending to have
    candles it was never given.

Endpoints. The widely-cited `/api/DB/BindHistoryInfo` was retired with the
site rebuild and now answers ERR-006 for everyone, which is why most guides
to TEFAS no longer work. The current routes are:

    POST /api/funds/fonFiyatBilgiGetir   {"fonKodu","dil","periyod"}
         -> {"resultList":[{"fonKodu","fonUnvan","kategoriDerece",
                            "kategoriFonSay","tarih","fiyat"}]}
         `periyod` is a lookback in MONTHS, not a date range. 60 is accepted,
         120 fails with "Sistem Hatası!!", so five years is the usable limit.
    POST /api/fund-returns/export        {"format","listingType","fundType","locale"}
         -> CSV listing; fundType BYF = the 37 exchange-traded funds,
            YAT = 2,136 open-ended mutual funds (not ETFs, no intraday).

    python3 tefas.py                   # ETF universe + daily NAV history
    python3 tefas.py --universe-only   # just the fund list
    python3 tefas.py --fund-type YAT   # the mutual fund list
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT_URL = "https://www.tefas.gov.tr/api/fund-returns/export"
PRICE_URL = "https://www.tefas.gov.tr/api/funds/fonFiyatBilgiGetir"
MAX_PERIOD_MONTHS = 60          # 120 is rejected by the service
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
# listingType must be one of: return, management, operatingExpense, size
DEFAULT_LISTING = "return"


def fetch_csv(fund_type: str = "BYF", listing: str = DEFAULT_LISTING,
              locale: str = "tr", timeout: int = 60) -> str:
    payload = json.dumps({
        "format": "csv",
        "listingType": listing,
        "fundType": fund_type,
        "locale": locale,
    }).encode()
    req = urllib.request.Request(
        EXPORT_URL, data=payload, method="POST",
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "Accept": "*/*",
            "Referer": "https://www.tefas.gov.tr/",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8-sig")


def fetch_prices(code: str, months: int = MAX_PERIOD_MONTHS, timeout: int = 45,
                 tries: int = 4) -> list[dict]:
    """Daily NAV for one fund. Returns [{"date": "YYYY-MM-DD", "price": float}].

    TEFAS drops connections when several requests arrive at once ("Remote end
    closed connection without response"), so transient failures are retried
    with a widening gap rather than counted as "this fund has no data".
    """
    import random
    import time as _time

    payload = json.dumps({"fonKodu": code, "dil": "TR",
                          "periyod": min(months, MAX_PERIOD_MONTHS)}).encode()
    body = None
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(
            PRICE_URL, data=payload, method="POST",
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/json",
                     "Accept": "application/json", "Referer": "https://www.tefas.gov.tr/"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = json.load(resp)
            break
        except Exception as exc:
            last = exc
            _time.sleep(1.5 * (attempt + 1) + random.random())
    if body is None:
        raise RuntimeError(f"{type(last).__name__}: {last}")

    rows = body.get("resultList")
    if not rows:
        return []
    out = []
    for r in rows:
        d, pr = r.get("tarih"), r.get("fiyat")
        if not d or pr is None:
            continue
        try:
            out.append({"date": str(d)[:10], "price": float(pr),
                        "title": r.get("fonUnvan")})
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda x: x["date"])
    return out


def parse(raw: str) -> list[dict]:
    """The export leads with '#' comment lines before the real header row."""
    lines = [l for l in raw.splitlines() if not l.startswith("#")]
    try:
        start = next(i for i, l in enumerate(lines) if l.lstrip().startswith('"Fon Kodu"'))
    except StopIteration:
        raise SystemExit("unexpected export layout: no 'Fon Kodu' header row")
    rows = list(csv.DictReader(io.StringIO("\n".join(lines[start:]))))

    def num(v):
        if v is None:
            return None
        v = v.strip().replace("%", "").replace(".", "").replace(",", ".")
        try:
            return float(v)
        except ValueError:
            return None

    out = []
    for r in rows:
        code = (r.get("Fon Kodu") or "").strip()
        if not code:
            continue
        out.append({
            "code": code,
            "title": (r.get("Fon Unvanı") or "").strip(),
            "type": (r.get("Fon Türü") or "").strip(),
            "risk": num(r.get("Fonun Risk Değeri")),
            "ret1m": num(r.get("1 Aylık Getiri")),
            "ret3m": num(r.get("3 Aylık Getiri")),
            "ret6m": num(r.get("6 Aylık Getiri")),
            "retYtd": num(r.get("Yılbaşından İtibaren Getiri")),
        })
    return out


# TEFAS fund codes and Borsa Istanbul tickers are different identifiers, so
# the two universes are joined on the fund's official title.
_STOP = {"portfoy", "portföy", "borsa", "yatirim", "yatırım", "fonu", "fon",
         "hisse", "senedi", "yogun", "yoğun", "endeksi", "endeks", "a.s", "a.ş",
         "model", "byf", "byf.", "type", "exchange", "traded", "etf", "b"}


def _tokens(title: str) -> set[str]:
    t = title.lower()
    for a, b in (("ı", "i"), ("ş", "s"), ("ğ", "g"), ("ü", "u"), ("ö", "o"), ("ç", "c")):
        t = t.replace(a, b)
    return {w for w in re.split(r"[^a-z0-9]+", t) if w and w not in _STOP and len(w) > 1}


def match_to_tickers(funds: list[dict], data_dir: str) -> list[dict]:
    """Attach the BIST ticker whose venue name best overlaps each TEFAS title."""
    listed = []
    tr_dir = os.path.join(data_dir, "tr")
    if os.path.isdir(tr_dir):
        for fn in sorted(os.listdir(tr_dir)):
            if not fn.endswith(".json"):
                continue
            try:
                rec = json.load(open(os.path.join(tr_dir, fn), encoding="utf-8"))
            except Exception:
                continue
            listed.append((rec["symbol"], rec.get("name") or "", _tokens(rec.get("name") or "")))

    # Turkish fund titles are near-identical within a category -- five houses
    # each run an "ALTIN KATILIM BORSA YATIRIM FONU". A confident-looking but
    # wrong ticker is worse than no ticker here, so a match is only accepted
    # when it is both strong and unambiguous, and each ticker is claimed once.
    MIN_SCORE, MIN_MARGIN = 0.55, 0.12
    scored = []
    for f in funds:
        ft = _tokens(f["title"])
        ranked = sorted(
            ((len(ft & nt) / len(ft | nt), sym) for sym, _, nt in listed if nt and ft),
            reverse=True)
        top = ranked[0] if ranked else (0.0, None)
        runner = ranked[1][0] if len(ranked) > 1 else 0.0
        f["matchScore"] = round(top[0], 3)
        ok = top[0] >= MIN_SCORE and (top[0] - runner) >= MIN_MARGIN
        scored.append((top[0] if ok else 0.0, f, top[1] if ok else None))
        f["ticker"] = None

    claimed: dict[str, float] = {}
    for score, f, sym in sorted(scored, key=lambda x: -x[0]):
        if sym and score and claimed.get(sym, 0.0) < score:
            claimed[sym] = score
            f["ticker"] = sym
    # one ticker, one fund: drop any later duplicate claim
    seen: set[str] = set()
    for f in sorted(funds, key=lambda x: -(x.get("matchScore") or 0)):
        t = f.get("ticker")
        if t and t in seen:
            f["ticker"] = None
        elif t:
            seen.add(t)
    return funds


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fund-type", nargs="+", default=["BYF"],
                    help="BYF = exchange-traded funds (default), YAT = mutual funds; "
                         "pass both to retrieve the whole Turkish fund universe")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--out", default=os.path.join(HERE, "tefas_universe.json"))
    ap.add_argument("--data", default=os.path.normpath(os.path.join(HERE, "..", "web", "data")))
    ap.add_argument("--print", dest="show", action="store_true", help="print the list")
    ap.add_argument("--no-match", action="store_true", help="skip BIST ticker matching")
    ap.add_argument("--universe-only", action="store_true",
                    help="do not retrieve prices, just write the fund list")
    ap.add_argument("--months", type=int, default=MAX_PERIOD_MONTHS,
                    help=f"lookback in months (service maximum {MAX_PERIOD_MONTHS})")
    ap.add_argument("--replace", action="store_true",
                    help="clear web/data/tr first, so only TEFAS funds remain")
    args = ap.parse_args()

    funds = []
    for ft in args.fund_type:
        got = parse(fetch_csv(ft))
        for f in got:
            f["fundClass"] = "etf" if ft == "BYF" else "mutual"
        print(f"-> TEFAS export fundType={ft}: {len(got)} funds")
        funds.extend(got)
    print(f"-> {len(funds)} funds total")

    if not args.no_match and args.fund_type == ["BYF"]:
        funds = match_to_tickers(funds, args.data)
        hit = sum(1 for f in funds if f.get("ticker"))
        print(f"-> matched {hit}/{len(funds)} to a Borsa Istanbul ticker already on disk")

    if args.show:
        for f in funds:
            tick = f.get("ticker") or "-"
            print(f"   {f['code']:<5} {tick:<11} risk={str(f['risk'] or '-'):<4} "
                  f"{f['type'][:24]:<24} {f['title'][:46]}")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"fundType": args.fund_type, "count": len(funds), "funds": funds},
                  fh, ensure_ascii=False, indent=1)
    print(f"-> {args.out}")

    if args.universe_only:
        return
    write_prices(funds, args.data, args.months, args.replace, args.workers)


def write_prices(funds, data_dir, months, replace, workers=4):
    """Retrieve each fund's NAV history and write it where the dashboard looks."""
    from datetime import datetime, timezone

    sys.path.insert(0, HERE)
    from classify import classify_tr
    from fetch_etfs import YTD_ANCHOR, load_all, summarise, write_manifest
    from resample import compact

    tr_dir = os.path.join(data_dir, "tr")
    os.makedirs(tr_dir, exist_ok=True)
    if replace:
        for fn in os.listdir(tr_dir):
            if fn.endswith(".json"):
                os.remove(os.path.join(tr_dir, fn))
        print(f"-> cleared {tr_dir}")

    import concurrent.futures as _cf
    import time as _t

    if not replace:
        before = len(funds)
        funds = [f for f in funds
                 if not os.path.exists(os.path.join(tr_dir, f["code"] + ".json"))]
        if before != len(funds):
            print(f"-> resuming: {before - len(funds)} already on disk, {len(funds)} to go")

    written, skipped = {}, []
    lock = __import__("threading").Lock()
    done = 0

    def work(f):
        try:
            rows = fetch_prices(f["code"], months)
        except Exception as exc:
            return f, None, str(exc)[:60]
        rec = to_record(f, rows)
        if not rec:
            return f, None, "no usable history"
        rec["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        rec["series"]["1d"] = compact(rec["series"]["1d"])
        rec["stats"] = summarise(rec["series"]["1d"], {}, "nav")
        _t.sleep(0.25)          # be gentle with a public service
        return f, rec, None

    # TEFAS answers server-side without throttling, but it is a public
    # service -- keep the pool small and leave a gap between requests.
    with _cf.ThreadPoolExecutor(max_workers=workers) as pool:
        for f, rec, err in pool.map(work, funds):
            done += 1
            if rec is None:
                skipped.append((f["code"], err))
                print(f"[{done:>4}/{len(funds)}] skip {f['code']:<5} {err}")
                continue
            path = os.path.join(tr_dir, rec["display"] + ".json")
            with lock:
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(rec, fh, separators=(",", ":"), ensure_ascii=False)
                written[rec["symbol"]] = rec
            if done % 100 == 0 or done == len(funds):
                print(f"[{done:>4}/{len(funds)}] {rec['display']:<5} "
                      f"{len(rec['series']['1d']['t']):>5} gun  "
                      f"{os.path.getsize(path)/1024:6.1f} KB")

    write_manifest(load_all(data_dir, written), data_dir, YTD_ANCHOR, [])
    print(f"-> {len(written)} TEFAS funds written, {len(skipped)} skipped")




# --------------------------------------------------------------------------
# Writing dashboard records
# --------------------------------------------------------------------------
# TEFAS fund types mapped onto the category vocabulary the US side already uses.
CATEGORY_BY_TYPE = {
    "Altın Fonu": "Precious Metal",
    "Gümüş Fonu": "Precious Metal",
    "Endeks Fon": "Equity Index",
    "Hisse Senedi Yoğun": "Equity Index",
    "Hisse Senedi Fonu": "Equity Index",
    "Yabancı Fon": "International",
    "Borçlanma Araçları": "Fixed Income",
    "Para Piyasası": "Fixed Income",
}
ISTANBUL_GMT_OFFSET = 3 * 3600


def categorise(fund: dict) -> str:
    """Category shown in the dashboard's sector filter.

    Exchange-traded funds get a single category of their own so the BYF
    market stays visible as one block among two thousand mutual funds.
    Mutual funds are grouped by TEFAS's own fund type, with the shared
    "Şemsiye Fonu" suffix trimmed off.
    """
    if fund.get("fundClass") == "etf":
        return "ETF (BYF)"
    t = (fund.get("type") or "").strip()
    for suffix in (" Şemsiye Fonu", " Fonu", " Fon"):
        if t.endswith(suffix):
            t = t[: -len(suffix)]
            break
    return t or "Diğer"


def to_record(fund: dict, rows: list[dict]) -> dict | None:
    """One TEFAS fund -> the same record shape fetch_etfs.py writes.

    TEFAS gives one NAV per day and no volume, so open/high/low/close all
    carry that single observed price and volume is zero. The record is
    tagged `priceType: "nav"` and the dashboard renders it as a line --
    inventing an intraday range from a daily NAV would be fabricating data.
    """
    import datetime as _dt

    t, px = [], []
    for r in rows:
        try:
            d = _dt.datetime.strptime(r["date"], "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc)
        except ValueError:
            continue
        price = float(r["price"])
        # TEFAS returns a full series of 0.00 for some funds (KHO does this
        # for all 815 of its rows). A zero is not a net asset value, it is a
        # gap in the feed, so it is dropped rather than charted.
        if price <= 0:
            continue
        t.append(int(d.timestamp()) - ISTANBUL_GMT_OFFSET)   # local midnight, in UTC
        px.append(round(price, 6))
    if len(t) < 2:
        return None

    series = {"t": t, "o": px[:], "h": px[:], "l": px[:], "c": px[:], "v": [0] * len(t)}
    return {
        # TEFAS codes are three letters and collide with US tickers -- BND is
        # both Vanguard Total Bond Market and Ak Portföy BIST Banka Dışı
        # Likit 10 -- so the stored symbol is namespaced. `display` stays the
        # plain fund code, which is what Turkish users recognise.
        "symbol": fund["code"] + ".TEFAS",
        "display": fund["code"],
        "name": fund.get("title") or rows[-1].get("title") or fund["code"],
        "market": "TR",
        "category": classify_tr(fund.get("title") or "", fund.get("type") or "",
                                fund.get("fundClass") == "etf")[0],
        "theme": classify_tr(fund.get("title") or "", fund.get("type") or "",
                             fund.get("fundClass") == "etf")[1],
        "currency": "TRY",
        "exchange": ("Borsa İstanbul (BYF Pazarı)" if fund.get("fundClass") == "etf"
                     else "TEFAS"),
        "timezone": "Europe/Istanbul",
        "gmtoffset": ISTANBUL_GMT_OFFSET,
        "instrumentType": "ETF" if fund.get("fundClass") == "etf" else "MUTUALFUND",
        "fundClass": fund.get("fundClass", "etf"),
        "priceType": "nav",
        "tefasCode": fund["code"],
        "tefasType": fund.get("type"),
        "riskValue": fund.get("risk"),
        "dailySource": "tefas",
        "baseIntervals": ["1d"],
        "series": {"1d": series},
    }

if __name__ == "__main__":
    main()
