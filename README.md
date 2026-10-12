# Bourse ETF Terminal

Price history for **2,093 exchange-traded funds** across the **United States**
(2,057) and **Borsa İstanbul** (36) — a
TradingView-style chart, thirteen time steps from one hour to one year, and
one-click Excel export of whatever window you are looking at.

Everything is free and keyless. Prices come from Yahoo Finance's public chart
endpoint (the same one finance.yahoo.com's own charts call), the retriever is
plain Python with **no third-party packages**, and the dashboard is static
files that deploy to any free host.

---

## 1. Access it

### Online

**https://claude.ai/code/artifact/d32405bd-39e8-449b-b290-39c84c49deec**

> Published artifacts are **private by default**. Open the link, use the page's
> **share menu** to allow anyone with the link, then confirm in a private
> browser window before handing the URL to anyone.

### Locally

```bash
python3 -m http.server 8080 --directory web
```

Then open <http://127.0.0.1:8080>. No build step, no dependencies — `web/` is
the whole site.

---

## 2. Quickstart

```bash
# 1. retrieve prices for both markets  (writes web/data/)
python3 retriever/fetch_etfs.py

# 2. serve the dashboard
python3 -m http.server 8080 --directory web

# 3. (optional) rebuild the Claude Artifact copy
python3 build_artifact.py
```

Requires Python 3.9+ and nothing else. Verified on Python 3.11.4.

---

## 3. The process, step by step

```
  Yahoo Finance chart endpoint  (public, keyless)
            │
            │  retriever/fetch_etfs.py        ← resumable, 2 requests per fund
            ▼
  per-fund 1h + 1d columnar OHLCV
            │
            │  retriever/resample.py          ← BIST daily bars aggregated from
            │                                   hourly; prices rounded; payload
            ▼                                   compacted
  web/data/manifest.json  +  web/data/{us,tr}/<TICKER>.json
            │
            │  web/app.js                     ← bucketing into 13 steps happens
            ▼                                   in the browser, not on disk
  chart · statistics · .xlsx / .csv export
```

### Step 1 — retrieve

```bash
python3 retriever/fetch_etfs.py --intervals 1d 1h
```

Each fund needs two requests. The run prints one line per fund as it lands, and
is **resumable**: a second pass keeps whatever is already on disk and only
fetches what is missing, so an interrupted run costs you nothing.

```
-> 5 symbols | markets=TR,US | intervals=1d,1h | daily history from 2020-01-01 | 5 workers | resume
[  1/5] ok   QQQ         1702 daily    168.9 KB  [1h/1d]
[  2/5] ok   SPY         1702 daily    169.3 KB  [1h/1d]
[  3/5] ok   GLD         1702 daily    166.6 KB  [1h/1d]
[  4/5] ok   ZPX30        725 daily    134.2 KB  [1h/1d]
[  5/5] ok   GLDTR        725 daily    131.7 KB  [1h/1d]
-> manifest: .../web/data/manifest.json (14.1 KB)

-> 5 ETFs stored, 0 skipped
```

A fast first pass is `--intervals 1d` (one request per fund); the dashboard is
already usable from that, and `--intervals 1d 1h` afterwards fills in the hourly
bars that the 1h–8h steps need.

### Step 2 — inspect what you got

```bash
python3 retriever/fetch_etfs.py --rebuild-manifest   # re-index web/data/ without network
```

```
-> manifest: .../web/data/manifest.json (14.1 KB)
```

`manifest.json` is the index the dashboard loads first: both markets, every
fund's last price, daily change, YTD change, 52-week range, average volume and
a 60-point sparkline. It is 1.6 MB raw but 430 KB gzipped, and the per-fund JSON
files are only fetched when you click a fund. The list renders the top 250 rows of
the current sort rather than all two thousand, and says so in its footer.

### Step 3 — serve and use

```bash
python3 -m http.server 8080 --directory web
```

| Request | Expected |
|---|---|
| `/` | 200 |
| `/app.js` | 200 |
| `/data/manifest.json` | 200 |
| `/data/tr/ZPX30.json` | 200 |

---

## 4. Time steps and how they are built

Only **two** resolutions are stored per fund. Everything coarser is resampled
in the browser, which keeps the payload at ~2.6 MB for 17 funds instead of
tens of megabytes.

| stored | window | feeds these steps |
|---|---|---|
| `1h` | last 400 days | **1h · 3h · 4h · 8h** |
| `1d` | from `--history-start` (default 2020-01-01) | **1D · 3D · 1W · 2W · 3W · 1M · 3M · 6M · 1Y** |

Aggregation is the standard OHLCV rule — open = first, high = max, low = min,
close = last, volume = sum — and bucket boundaries are cut in **exchange-local
time**, so a "1D" bar is a real Istanbul or New York session rather than a UTC
day straddling two of them. Weekly buckets start Monday; monthly, quarterly,
half-year and yearly buckets start on calendar boundaries.

**Why daily history reaches back to 2020.** The dashboard opens on *YTD 2026*,
which is the window this project is about. The daily series is stored from 2020
anyway because the 6M and 1Y steps would otherwise render one or two buckets and
look broken. It costs one request per fund and about 25 KB.

---

## 5. Borsa İstanbul: a real caveat

Yahoo publishes **6,000+ hourly bars** for BIST ETFs but returns **exactly one
daily bar** — every `range` and `period1/period2` combination gives the same
single row. The daily series for those funds is therefore aggregated from the
hourly series by `resample.ensure_daily()`, in Istanbul local time.

Funds where this happened are labelled **"daily bars aggregated from hourly"**
in the instrument header, and the export's Summary sheet records it under
*Daily series origin*. The retriever prints it too:

```
   ok ZPX30    TR    725d  6291h    134.2 KB  (daily aggregated from 1h)
   ok APGLD    TR     89d   509h     24.0 KB  (daily aggregated from 1h)
```

Consequence: Turkish funds have roughly two years of daily history (as far back
as the hourly feed reaches), not the full listing history.

---

## 6. If you get HTTP 429

Yahoo throttles cookieless clients **by IP**, and once tripped it stays tripped
for a while — every server-side request returns `429 Too Many Requests`:

```
[gate] HTTP 429 -- waiting 25s (attempt 24)
[gate] HTTP 429 -- waiting 25s (attempt 25)
```

`run_sample.sh` and `run_all.sh` wait this out on their own. If it does not
clear, collect the same payloads from a real browser session instead, which is
not throttled because it carries ordinary session cookies:

```bash
python3 retriever/receiver.py            # local drop box on 127.0.0.1:8787
```

1. Open **<http://127.0.0.1:8787/pull>**. It lists how many funds are still
   missing and hands you a snippet.
2. Follow its instructions: open the Yahoo chart URL it links to, open the
   browser console there, paste the snippet and press Enter.

   The snippet has to run **on Yahoo's origin**, not on this page — the chart
   endpoint sends no CORS headers, so a collector served from `127.0.0.1`
   cannot fetch it. The snippet only reads public price data and posts the
   result back to your own drop box.
3. Convert the capture into the normal data files:

```bash
python3 retriever/build_from_raw.py
```

```
-> 34 captured series from bundle.json
   ok ARKK     US   1702d  5090h    155.1 KB
   ok GLDTR    TR    725d  6282h    131.7 KB  (daily aggregated from 1h)
   ok SPY      US   1702d  5090h    169.3 KB
   ...
-> manifest: .../web/data/manifest.json (14.1 KB)
-> 17 ETFs written to .../web/data
```

The output is byte-identical in shape to what `fetch_etfs.py` writes — same
files, same manifest, same dashboard. **This is how the dataset currently in
`web/data/` was collected**, because the throttle was active throughout the
build.

---

## 7. Retriever reference

```bash
python3 retriever/fetch_etfs.py [options]
```

| Option | Meaning |
|---|---|
| `--markets US TR` | which markets to retrieve (default: both) |
| `--only SPY QQQ ZPX30` | restrict to specific tickers (`.IS` optional) |
| `--intervals 1d 1h` | which base resolutions this pass should fetch |
| `--history-start 2020-01-01` | first date of the daily series |
| `--workers 5` | concurrent requests — lower this if throttled |
| `--pause 0.3` | base delay between requests, seconds |
| `--refresh` | refetch intervals already on disk instead of resuming |
| `--probe-candidates` | also try the extra BIST tickers in `universe.TR_CANDIDATES` |
| `--rebuild-manifest` | re-index `web/data/` without touching the network |
| `--out PATH` | output directory (default `web/data`) |

Convenience scripts:

```bash
./retriever/run_sample.sh     # ~17 funds, both markets  (what is deployed now)
./retriever/run_all.sh        # the full ~100-fund universe, staged
```

Both wait for the endpoint to answer before starting, then run `1d` first and
`1h` second so the dataset becomes usable as early as possible.

### Adding funds

Edit `retriever/universe.py` — `US_ETFS` and `TR_ETFS` are `(symbol, category)`
pairs; `TR_CANDIDATES` is a list of extra Borsa İstanbul tickers probed only
with `--probe-candidates`. Symbols that return no usable history are skipped
and listed at the end of the run, so over-listing is harmless.

---

## 8. Deploying free

The site is `web/` — static files, no build step. All three of these are free
forever at this size (~2.6 MB).

**Vercel** (recommended — `vercel.json` already points at `web/`):

```bash
npx vercel deploy --prod
```

**Cloudflare Pages / Netlify** — connect the repository, leave the build
command empty, set the output directory to `web`.

**GitHub Pages** — push the repository, then either rename `web/` to `docs/`
and serve from *Settings → Pages → branch root /docs*, or push the contents of
`web/` to a `gh-pages` branch.

**Claude Artifacts** — `python3 build_artifact.py` rewrites `artifact/` from
`web/` (stripping the `<!doctype>`/`<head>`/`<body>` wrapper, which the artifact
host supplies). The artifact build also uses the `downloads` capability so the
Excel export works inside the viewer sandbox; on an ordinary host the same code
falls back to a normal browser download.

---

## 9. Using the dashboard

- **Market tabs** switch between United States and Türkiye. The list is
  filterable by ticker or name, narrowable by sector, and sortable by ticker,
  last price or daily change.
- **Period** is the window (5D · 1M · 3M · 6M · YTD 2026 · 1Y · 2Y · Max · a
  custom date pair). It opens on YTD 2026.
- **Time step** is the bar size — 1h through 1Y. Steps whose base resolution is
  missing for a fund are disabled rather than silently empty, and if the stored
  hourly history does not reach the start of your period the chart says so
  instead of quietly truncating.
- **Chart**: candles, hollow candles, bars, line or area; volume, SMA 20 and
  SMA 50 overlays; crosshair with an OHLC legend; drag to pan, scroll to zoom,
  **Fit** to reset.
- **Statistics** under the chart are computed over the visible window: period
  open/high/low/close with dates, return, max drawdown, annualised volatility
  and volume.
- **Download Excel (.xlsx)** exports exactly the bars on screen:
  - *Prices* — row number, period start in exchange-local time, OHLC, change,
    change %, volume, and the UTC ISO-8601 timestamp, with an autofilter and a
    frozen header.
  - *Summary* — symbol, name, market, exchange, currency, the period and step
    you chose, bar count, period statistics, the resampling rule applied, the
    daily series origin, the data source and both retrieval and export
    timestamps.

  CSV is available alongside it (UTF-8 BOM, so Excel opens Turkish characters
  correctly).

---

## 10. Project layout

```
retriever/
  universe.py          ETF universe for both markets, with sector tags
  fetch_etfs.py        the retriever — resumable, multi-pass, stdlib only
  resample.py          OHLCV aggregation + price rounding / payload compaction
  receiver.py          local drop box for the browser fallback
  pull.html            browser-side collector served at /pull
  build_from_raw.py    turns a browser capture into the normal data files
  run_sample.sh        a handful of funds per market
  run_all.sh           the full universe, staged 1d then 1h
web/                   the deployable site
  index.html           markup + design tokens (light and dark)
  app.js               chart, resampling, statistics, export
  data/manifest.json   index + headline stats for both markets
  data/us/*.json       one file per fund
  data/tr/*.json
artifact/              the same page rebuilt for Claude Artifacts
build_artifact.py      derives artifact/ from web/
vercel.json            static config — output directory web/
```

---

## 11. Notes

- Prices are **unadjusted last-traded values** — no dividend or split
  adjustment is applied. Use them for study and coursework, not for
  performance attribution.
- The dataset ships with **2,093 funds — 2,057 US and 36 Borsa İstanbul**. The US
  side is the Nasdaq symbol directory via `us_universe.py`; the Turkish side is the
  complete TEFAS BYF registry. Tickers the venue does not classify as an
  ETF are rejected by the retriever, so guessed BIST codes that turn out to be
  ordinary listed companies never reach the dashboard.
- Nothing in this repository is investment advice.
