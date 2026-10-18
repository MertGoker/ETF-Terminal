# Bourse ETF Terminal

Price history for **7,796 funds** across the **United States** (5,692 ETFs)
and **Türkiye** (2,104 TEFAS funds) — a
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

# 3. (optional) the control plane behind the System page
pip install -r control_plane/requirements.txt
python3 -m uvicorn control_plane.main:app --port 8000
```

The dashboard requires Python 3.9+ and nothing else — the retriever is standard
library only. FastAPI and uvicorn are needed solely for the System page's health
checks and sync button; without them the dashboard still runs, in static mode.
Verified on Python 3.11.4.

---

## 3. The four pages

The terminal is one static page with four sections, switched by the nav and
addressable by hash (`#home`, `#etfs`, `#portfolio`, `#system`). Pages are
toggled rather than rebuilt, so the chart, the selected fund and the scroll
position all survive moving between them.

| Page | State |
|---|---|
| **Home** | reserved — placeholder only |
| **ETFs** | the working terminal: fund list, chart, statistics, Excel export |
| **My Portfolio** | reserved — placeholder only |
| **System** | operations — health, deployment status, data synchronisation |

Three typefaces, chosen by what each page is for:

| Page | Typeface | Why |
|---|---|---|
| ETFs | **Playfair Display** | the Didone trading-desk treatment, unchanged |
| Home · My Portfolio | **DM Sans** | read rather than scanned, so a clear grotesque |
| System | **Bitcount Ink** | a machine readout, so a bitmap-grid display face |

Those three are the only families the page loads — one Google Fonts request,
no fourth face anywhere. On the System page Bitcount Ink carries the structure
and the numbers: banner titles, status pills, readouts, dates, latencies and the
streamed log. Buttons, running prose and the URL fields stay in DM Sans, because
a bitmap grid on a filled button turns to mush at that size and a URL you type
has to be checkable.

---

## 4. The System page

Four status banners, one line each, so the whole operational picture and both
actions fit a single screen. Detail sits behind a per-banner disclosure; the two
buttons sit directly below the banners, each under the stamp it acts on.

1. **Dashboard runtime** — the page you are looking at. Green when the script is
   running, the manifest parsed, the chart engine loaded, `data/` reachable and
   browser storage writable. Each probe reports what it measured, not a bare
   boolean.
2. **Public deployment** — green when the terminal is served from a public
   origin. Locally it reads amber ("Local only") until you enter the deployed
   URL; it then probes that host and goes green or red.
3. **Control plane** — the FastAPI service in `api/`. Offline is a *supported*
   state, not a failure: the dashboard is static and works without it, so this
   reads "Offline — static mode" rather than a false red.
4. **Data synchronization** — the newest stored bar per market with its age, and
   the button that refreshes it.

**Run health check** probes all four at once and reports an overall verdict.

### Upstream failures are reported, not buried

The price feed rate-limits by IP, and with backoff a throttled run can go
minutes without printing anything — indistinguishable from a hang. So the
retriever emits machine-readable diagnostics:

```
    ~ RETRY  code=rate_limited subject=SPY wait=9s :: HTTP 429 Too Many Requests
    ~ GIVEUP code=rate_limited subject=SPY :: HTTP 429 ... after 6 attempts
```

The control plane parses these, groups them by code and ranks them by
severity; the System page renders them as cards next to the button, with the
affected tickers and what to do about it. Three things make a throttle
visible without reading a log:

* **Before you press it** — `GET /api/upstream` probes each source. A blocked
  feed turns the panel pill red ("Upstream blocked") and the button reads
  *Synchronize anyway*, since the retriever backs off and may still get
  through.
* **While it runs** — retry and give-up counts accumulate live per error code.
* **When it stalls** — a job with no progress for 25 s says so, and names the
  backoff as the reason when the feed is throttling.

### Control plane (optional)

A static page cannot inspect its own data on disk or re-run the retriever. That
is what `api/` is for.

```bash
pip install -r control_plane/requirements.txt
python3 -m uvicorn control_plane.main:app --reload --port 8000
```

There are **two** control planes answering the same client code. Locally it is
this FastAPI service, which can read the data directory and run the retriever
itself. On the deployed site it is the Vercel functions in `api/`, which
dispatch a GitHub Actions run instead — a serverless function cannot do minutes
of work and write thousands of files, but it can hold the token that starts
something which can. The System page detects which one answered and adapts:
deep health checks and the upstream probe are local-only, because they measure
the machine the retriever would actually run on.

See **DEPLOY.md** for wiring the button up in production.

| Route | Purpose |
|---|---|
| `GET /api/ping` | liveness, version, uptime |
| `GET /api/health` | deep check — data dir, manifest, fund counts, manifest/disk agreement, retriever modules, freshness, disk |
| `GET /api/sync/state` | newest stored bar per market |
| `POST /api/sync` | start a background sync, returns a job id |
| `GET /api/sync/{id}` | job state, counters, streamed log |
| `GET /api/jobs` | running job and recent history |

Interactive docs at <http://127.0.0.1:8000/api/docs>.

**What Synchronize does.** It re-runs `retriever/fetch_etfs.py` over the window
from the manifest's history start to today at the stored daily resolution.
Because every coarser step — 3D through 1Y — is resampled from daily bars in the
browser, one daily sync refreshes every step the terminal offers. The job runs
in the background, the page streams its log, and one sync runs at a time.

**On a deployed site the control plane is not reachable.** A static host serves
files and nothing else, and a page on HTTPS cannot call `http://127.0.0.1`
anyway. The System page says so and disables the sync button with the command
needed to enable it, instead of showing a broken green. Runtime and deployment
health still work everywhere.

---

## 5. The process, step by step

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

## 6. Time steps and how they are built

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

## 7. Borsa İstanbul: a real caveat

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

## 8. If you get HTTP 429

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

## 9. Retriever reference

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

## 10. Deploying free

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

## 11. Using the dashboard

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

## 12. Project layout

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
control_plane/         local FastAPI control plane (health + sync)
  main.py              routes, probes, background job runner
  requirements.txt     fastapi + uvicorn
api/                   Vercel serverless functions (deployed control plane)
  ping.mjs             liveness + which mode this plane is
  sync.mjs             dispatch the GitHub Actions run
  sync-status.mjs      run progress, normalised to the local job shape
  sync-state.mjs       newest stored bar, read from the published manifest
.github/workflows/
  sync.yml             the retriever job that actually refreshes prices
control_plane/         local FastAPI control plane (health + sync)
  main.py              routes, probes, background job runner
  requirements.txt     fastapi + uvicorn
api/                   Vercel serverless functions (deployed control plane)
  ping.mjs             liveness + which mode this plane is
  sync.mjs             dispatch the GitHub Actions run
  sync-status.mjs      run progress, normalised to the local job shape
  sync-state.mjs       newest stored bar, read from the published manifest
.github/workflows/
  sync.yml             the retriever job that actually refreshes prices
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

## 13. Notes

- Prices are **unadjusted last-traded values** — no dividend or split
  adjustment is applied. Use them for study and coursework, not for
  performance attribution.
- The dataset ships with **7,796 funds — 5,692 US and 2,104 Turkish**. That is the
  whole reachable universe: 5,692 of the 5,771 ETFs in the Nasdaq symbol directory
  return usable history, and 2,104 of TEFAS's 2,173 funds do — the other 69 are
  published with a price of 0.00 every day, so they are skipped rather than charted.
- Nothing in this repository is investment advice.
