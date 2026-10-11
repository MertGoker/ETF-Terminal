"""
Server-side OHLCV aggregation.

Only one case needs it: Borsa Istanbul ETFs. Yahoo publishes 730 days of
hourly bars for them but returns a single daily bar, so the daily series --
which the dashboard's 1D/3D/1W/.../1Y steps and all the summary statistics
are built from -- has to be aggregated from the hourly series here.

Buckets are cut in exchange-local time, so a "day" is a real Istanbul
trading session rather than a UTC day straddling two sessions. This mirrors
the bucketing the browser applies to every coarser step.
"""
from __future__ import annotations

MIN_REAL_DAILY = 20          # fewer bars than this means the feed gave us nothing


def daily_from_hourly(hourly: dict, gmtoffset: int) -> dict | None:
    """Aggregate an hourly columnar series into exchange-local daily bars."""
    if not hourly or not hourly.get("t"):
        return None
    gmt = int(gmtoffset or 0)
    t, o, h, l, c, v = (hourly[k] for k in ("t", "o", "h", "l", "c", "v"))

    out = {"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    day = None
    for i, ts in enumerate(t):
        d = (ts + gmt) // 86400
        if d != day:
            day = d
            out["t"].append(d * 86400 - gmt)     # local midnight, expressed in UTC
            out["o"].append(o[i])
            out["h"].append(h[i])
            out["l"].append(l[i])
            out["c"].append(c[i])
            out["v"].append(v[i])
        else:
            if h[i] > out["h"][-1]:
                out["h"][-1] = h[i]
            if l[i] < out["l"][-1]:
                out["l"][-1] = l[i]
            out["c"][-1] = c[i]
            out["v"][-1] += v[i]
    return out if out["t"] else None


def ensure_daily(series: dict, gmtoffset: int) -> str | None:
    """
    Make sure `series` has a usable '1d' entry, deriving it from '1h' when the
    provider only returned a stub. Returns the source of the daily series:
    'feed', '1h', or None when neither is available.
    """
    daily = series.get("1d")
    if daily and len(daily.get("t") or []) >= MIN_REAL_DAILY:
        return "feed"
    derived = daily_from_hourly(series.get("1h"), gmtoffset)
    if derived:
        series["1d"] = derived
        return "1h"
    return "feed" if daily else None


def round_price(x: float) -> float:
    """Trim stored precision to what the venue actually quotes.

    Feeds return float noise (88.57000732421875). Keeping six decimals on a
    5,000-bar hourly series roughly doubles the payload for digits no screen
    or spreadsheet ever shows.
    """
    ax = abs(x)
    if ax >= 1000:
        return round(x, 2)
    if ax >= 100:
        return round(x, 3)
    if ax >= 1:
        return round(x, 4)
    return round(x, 6)


def compact(series: dict, max_days: int | None = None, now: int | None = None) -> dict:
    """Shrink a columnar series for shipping: round prices, optionally clip
    the lookback to the most recent `max_days`."""
    import time as _time
    t = series["t"]
    start = 0
    if max_days:
        cutoff = (now or int(_time.time())) - max_days * 86400
        while start < len(t) and t[start] < cutoff:
            start += 1
        if start >= len(t):
            start = 0                      # never clip a series out of existence
    out = {"t": t[start:]}
    for k in ("o", "h", "l", "c"):
        out[k] = [round_price(x) for x in series[k][start:]]
    out["v"] = series["v"][start:]
    return out
