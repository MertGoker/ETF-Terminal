#!/usr/bin/env python3
"""
Bourse ETF Terminal — control-plane API.

The dashboard itself is static: it reads JSON from `web/data/` and needs no
server at all, which is what lets it deploy to any free static host. This
service is the optional half that a static page cannot do for itself:

  * real health checks   -- is the data on disk coherent, are the retriever
                            modules importable, how stale is the newest bar
  * data synchronisation -- re-run the retriever for the window between the
                            newest stored bar and today, as a background job
                            the System page can watch

When this service is not running the System page degrades to "static mode":
the dashboard keeps working, the sync button is disabled, and the page says
so rather than showing a false green.

    pip install -r api/requirements.txt
    python3 -m uvicorn control_plane.main:app --reload --port 8000

Routes are mounted under /api so the page can talk to this service locally and
to the Vercel functions in `api/` in production with the same client code.

It lives outside `api/` on purpose: Vercel treats a root-level `api/` directory
as its serverless functions, and a long-running FastAPI app is the one thing
that cannot be deployed that way.
"""
from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timezone, date

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "web", "data")
RETRIEVER = os.path.join(ROOT, "retriever")
STARTED_AT = time.time()
VERSION = "1.0.0"

app = FastAPI(
    title="Bourse ETF Terminal control plane",
    version=VERSION,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

# The dashboard may be opened from a file, a local dev server, or a static
# host, so the browser origin is not predictable. Nothing here is
# authenticated and nothing is destructive beyond re-running the retriever,
# so an open CORS policy is the honest setting for a local control plane.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- utilities
def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def read_manifest() -> dict | None:
    path = os.path.join(DATA, "manifest.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def count_funds() -> dict[str, int]:
    out = {}
    for market in ("us", "tr"):
        d = os.path.join(DATA, market)
        out[market.upper()] = (
            len([f for f in os.listdir(d) if f.endswith(".json")])
            if os.path.isdir(d) else 0
        )
    return out


def newest_bar() -> dict:
    """
    The freshness figure the Sync panel is built around: the most recent
    daily bar actually stored, per market. Sampling beats scanning -- reading
    eight thousand files to answer a health check would itself be the
    slowest thing on the page -- so this reads the newest files by mtime and
    takes the latest bar date it finds.
    """
    result: dict[str, dict] = {}
    for market in ("us", "tr"):
        d = os.path.join(DATA, market)
        if not os.path.isdir(d):
            continue
        files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".json")]
        if not files:
            continue
        files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        latest, sampled = None, 0
        for path in files[:40]:
            try:
                with open(path, encoding="utf-8") as fh:
                    rec = json.load(fh)
            except Exception:
                continue
            stamps = ((rec.get("series") or {}).get("1d") or {}).get("t") or []
            if not stamps:
                continue
            sampled += 1
            day = datetime.fromtimestamp(stamps[-1], timezone.utc).strftime("%Y-%m-%d")
            if latest is None or day > latest:
                latest = day
        if latest:
            age = (date.today() - date.fromisoformat(latest)).days
            result[market.upper()] = {
                "lastBar": latest,
                "ageDays": age,
                "sampled": sampled,
                "files": len(files),
            }
    return result


def check(name: str, ok: bool, detail: str, level: str = "error") -> dict:
    """A single probe result. `level` is the severity when ok is False."""
    return {
        "name": name,
        "status": "pass" if ok else level,
        "detail": detail,
    }


# ------------------------------------------------------------------- health
@app.get("/api/ping")
def ping():
    """Cheapest possible liveness probe — the page polls this."""
    return {
        "ok": True,
        "service": "bourse-control-plane",
        "version": VERSION,
        "uptimeSeconds": round(time.time() - STARTED_AT, 1),
        "time": _iso(time.time()),
    }


@app.get("/api/health")
def health():
    """
    Deep check. Every probe is something that can actually be wrong, and
    each one reports what it measured rather than a bare boolean.
    """
    checks: list[dict] = []

    data_ok = os.path.isdir(DATA)
    checks.append(check("Data directory", data_ok,
                        DATA if data_ok else f"missing: {DATA}"))

    manifest = read_manifest()
    checks.append(check("Manifest", manifest is not None,
                        f"generated {manifest.get('generatedAt')}" if manifest
                        else "data/manifest.json unreadable"))

    counts = count_funds() if data_ok else {}
    total = sum(counts.values())
    declared = sum((m.get("count") or 0) for m in (manifest or {}).get("markets", {}).values())
    checks.append(check("Fund files", total > 0,
                        f"{total} on disk ({', '.join(f'{k} {v}' for k, v in counts.items())})"
                        if total else "no per-fund JSON found"))
    if manifest and declared:
        drift = abs(declared - total)
        checks.append(check("Manifest / disk agreement", drift <= max(5, declared * 0.01),
                            f"manifest declares {declared}, disk holds {total}",
                            level="warn"))

    for mod in ("fetch_etfs.py", "tefas.py", "resample.py"):
        p = os.path.join(RETRIEVER, mod)
        checks.append(check(f"Retriever · {mod}", os.path.exists(p),
                            "present" if os.path.exists(p) else "missing"))

    fresh = newest_bar()
    worst = max((v["ageDays"] for v in fresh.values()), default=None)
    if worst is not None:
        checks.append(check("Data freshness", worst <= 7,
                            " · ".join(f"{k} {v['lastBar']} ({v['ageDays']}d old)"
                                       for k, v in fresh.items()),
                            level="warn"))

    try:
        usage = shutil.disk_usage(ROOT)
        free_gb = usage.free / 1e9
        checks.append(check("Disk", free_gb > 1.0,
                            f"{free_gb:.1f} GB free of {usage.total/1e9:.0f} GB",
                            level="warn"))
    except Exception as exc:
        checks.append(check("Disk", False, str(exc), level="warn"))

    has_error = any(c["status"] == "error" for c in checks)
    has_warn = any(c["status"] == "warn" for c in checks)
    return {
        "status": "error" if has_error else "warn" if has_warn else "pass",
        "checkedAt": _iso(time.time()),
        "version": VERSION,
        "uptimeSeconds": round(time.time() - STARTED_AT, 1),
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "root": ROOT,
        },
        "counts": counts,
        "freshness": fresh,
        "checks": checks,
    }


@app.get("/api/sync/state")
def sync_state():
    """What the Sync panel shows before anything is pressed."""
    manifest = read_manifest()
    return {
        "freshness": newest_bar(),
        "manifestGeneratedAt": (manifest or {}).get("generatedAt"),
        "historyStart": (manifest or {}).get("historyStart"),
        "baseInterval": "1d",
        "note": "Daily bars are the stored resolution; every coarser step is "
                "resampled in the browser, so a daily sync refreshes all of them.",
        "running": JOBS.current_id(),
    }


# ---------------------------------------------------------- diagnostics
# The retriever emits machine-readable lines for everything that goes wrong
# upstream:
#     ~ RETRY  code=rate_limited subject=SPY wait=9s :: HTTP 429 Too Many Requests
#     ~ GIVEUP code=rate_limited subject=SPY :: HTTP 429 ... after 6 attempts
# Parsing them here is what lets the System page say "upstream is throttling
# you" instead of showing a progress bar that has not moved in four minutes.
DIAG_RE = re.compile(
    r"^\s*~\s+(?P<kind>RETRY|GIVEUP)\s+code=(?P<code>\S+)\s+subject=(?P<subject>\S+)"
    r"(?:\s+wait=(?P<wait>[\d.]+)s)?\s*::\s*(?P<detail>.*)$")
SKIP_RE = re.compile(r"^\[\s*\d+/\s*\d+\]\s+skip\s+(?P<sym>\S+)\s+\((?P<reason>[^)]*)\)")

# code -> how to present it. Anything unlisted is surfaced verbatim at
# warning level rather than being swallowed.
DIAG_CATALOGUE = {
    "rate_limited": (
        "warn", "Upstream is rate-limiting",
        "The price feed throttles by IP and the block is sticky. The retriever "
        "backs off automatically and will keep trying; running from a different "
        "network usually clears it immediately."),
    "timeout": (
        "warn", "Upstream timed out",
        "Requests are not completing. Usually a slow link rather than a block."),
    "network": (
        "error", "Network unreachable",
        "DNS or connectivity failed. Check this machine's internet access."),
    "upstream_5xx": (
        "warn", "Upstream server error",
        "The provider returned a 5xx. Usually transient — retry later."),
    "not_found": (
        "info", "Symbol not published",
        "The feed has no series for these tickers. They are skipped, which is "
        "normal for delisted or newly filed funds."),
    "http_error": (
        "warn", "Unexpected HTTP status",
        "The provider answered with a status the retriever does not special-case."),
    "no_history": (
        "info", "No usable history",
        "The feed answered but returned no daily bars for these funds."),
}


def describe(code: str) -> tuple[str, str, str]:
    return DIAG_CATALOGUE.get(code, ("warn", f"Upstream reported {code}", ""))


def note_diagnostic(job: dict, code: str, kind: str, subject: str, detail: str) -> None:
    """Fold one event into the job's diagnostic roll-up."""
    bag = job.setdefault("diagnostics", {})
    d = bag.get(code)
    if d is None:
        severity, title, hint = describe(code)
        d = bag[code] = {
            "code": code, "severity": severity, "title": title, "hint": hint,
            "retries": 0, "failures": 0, "detail": detail,
            "subjects": [], "firstAt": _iso(time.time()), "lastAt": None,
        }
    if kind == "GIVEUP":
        d["failures"] += 1
        # a code that only ever retried is a warning; one that gave up is not
        if d["severity"] == "warn" and code in ("rate_limited", "timeout", "upstream_5xx"):
            d["severity"] = "error"
    else:
        d["retries"] += 1
    d["detail"] = detail or d["detail"]
    d["lastAt"] = _iso(time.time())
    if subject and subject not in d["subjects"] and len(d["subjects"]) < 12:
        d["subjects"].append(subject)


# ------------------------------------------------------------- sync jobs
class JobRegistry:
    """
    One sync at a time, in-process. The retriever is network-bound and
    rate-limited at the source, so running two at once makes both slower and
    neither safer -- a second request is refused rather than queued.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._current: str | None = None
        self._lock = asyncio.Lock()

    def current_id(self) -> str | None:
        jid = self._current
        if jid and self._jobs.get(jid, {}).get("state") in ("running", "starting"):
            return jid
        return None

    def get(self, jid: str) -> dict | None:
        return self._jobs.get(jid)

    def recent(self, limit: int = 8) -> list[dict]:
        jobs = sorted(self._jobs.values(), key=lambda j: j["startedAt"], reverse=True)
        return [job_view(j) for j in jobs[:limit]]

    def create(self, markets: list[str], since: str | None) -> dict:
        jid = uuid.uuid4().hex[:12]
        job = {
            "id": jid,
            "state": "starting",
            "markets": markets,
            "since": since,
            "startedAt": _iso(time.time()),
            "finishedAt": None,
            "returnCode": None,
            "lines": 0,
            "ok": 0,
            "skipped": 0,
            "lastProgressAt": time.time(),
            "diagnostics": {},
            "log": [],
        }
        self._jobs[jid] = job
        self._current = jid
        return job


JOBS = JobRegistry()


class SyncRequest(BaseModel):
    markets: list[str] = ["US", "TR"]
    since: str | None = None      # YYYY-MM-DD; defaults to the manifest's historyStart
    limit: int | None = None      # cap the number of funds, for a quick test run


async def _run_sync(job: dict, markets: list[str], since: str, limit: int | None) -> None:
    """
    Drive the existing retriever as a subprocess and stream its output into
    the job log. The retriever is the single source of truth for how data is
    fetched and written -- this does not reimplement any of it.
    """
    cmd = [
        sys.executable, "-u", os.path.join(RETRIEVER, "fetch_etfs.py"),
        "--markets", *markets,
        "--intervals", "1d",          # the stored base resolution
        "--history-start", since,
        "--refresh",                  # re-pull the window instead of resuming
        "--workers", "4",
    ]
    if limit:
        cmd += ["--limit", str(limit)]

    job["state"] = "running"
    job["command"] = " ".join(cmd[1:])
    job["log"].append(f"$ {' '.join(cmd[1:])}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=ROOT,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except Exception as exc:
        job["state"] = "failed"
        job["finishedAt"] = _iso(time.time())
        job["log"].append(f"! could not start retriever: {exc}")
        return

    job["pid"] = proc.pid
    assert proc.stdout is not None
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").rstrip()
        if not line:
            continue
        job["lines"] += 1
        if " ok " in line:
            job["ok"] += 1
            job["lastProgressAt"] = time.time()
        elif " skip " in line:
            job["skipped"] += 1
            job["lastProgressAt"] = time.time()
            m = SKIP_RE.match(line)
            if m:
                reason = m.group("reason").lower()
                code = ("no_history" if "history" in reason or "data" in reason
                        else "not_found" if "not" in reason else "http_error")
                note_diagnostic(job, code, "GIVEUP", m.group("sym"), m.group("reason"))

        m = DIAG_RE.match(line)
        if m:
            note_diagnostic(job, m.group("code"), m.group("kind"),
                            m.group("subject"), m.group("detail"))
        # Keep the tail bounded: a full run prints thousands of lines and the
        # page only ever shows the end of it.
        job["log"].append(line)
        if len(job["log"]) > 400:
            del job["log"][: len(job["log"]) - 400]

    rc = await proc.wait()
    job["returnCode"] = rc
    job["state"] = "done" if rc == 0 else "failed"
    job["finishedAt"] = _iso(time.time())
    job["log"].append(f"— retriever exited with code {rc}")


SEVERITY_ORDER = {"error": 0, "warn": 1, "info": 2}


def job_view(job: dict, tail: int | None = None) -> dict:
    """Serialise a job for the page: diagnostics as a ranked list, plus how
    long it has been since the retriever last made progress."""
    out = {k: v for k, v in job.items() if k not in ("log", "diagnostics", "lastProgressAt")}
    diags = sorted(job.get("diagnostics", {}).values(),
                   key=lambda d: (SEVERITY_ORDER.get(d["severity"], 9), -d["retries"]))
    out["diagnostics"] = diags
    running = job["state"] in ("running", "starting")
    out["stalledSeconds"] = (
        round(time.time() - job.get("lastProgressAt", time.time()))
        if running else 0)
    if tail:
        out["log"] = job["log"][-max(1, min(tail, 400)):]
    return out


# ----------------------------------------------------------------- upstream
UPSTREAM = [
    {"id": "yahoo", "label": "Yahoo Finance (US prices)",
     "url": "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d"},
    {"id": "tefas", "label": "TEFAS (Türkiye universe)",
     "url": "https://www.tefas.gov.tr/"},
]


def probe_one(src: dict, timeout: float = 8.0) -> dict:
    """
    One HEAD-ish GET per source. The point is not the payload but the status:
    a 429 here is the single most useful thing the System page can tell you
    before you press Synchronize and wait four minutes for nothing.
    """
    req = urllib.request.Request(src["url"], headers={
        "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"),
        "Accept": "application/json,text/html;q=0.9",
        "Referer": "https://finance.yahoo.com/",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(2048)
            return {**_src(src), "status": "pass", "httpStatus": resp.status,
                    "ms": round((time.time() - t0) * 1000),
                    "detail": f"HTTP {resp.status}"}
    except urllib.error.HTTPError as exc:
        ms = round((time.time() - t0) * 1000)
        # A redirect means the host answered. Several of these sites bounce
        # the bare URL through a consent or locale hop, which is not a fault.
        if 300 <= exc.code < 400:
            return {**_src(src), "status": "pass", "httpStatus": exc.code, "ms": ms,
                    "detail": f"HTTP {exc.code} (redirect) — host answering"}
        code = "rate_limited" if exc.code in (429, 999) else "http_error"
        severity, title, hint = describe(code)
        return {**_src(src), "status": "error" if code == "rate_limited" else "warn",
                "httpStatus": exc.code, "ms": ms,
                "code": code, "detail": f"HTTP {exc.code} {exc.reason}"[:80],
                "title": title, "hint": hint}
    except Exception as exc:
        severity, title, hint = describe("network")
        return {**_src(src), "status": "error", "httpStatus": None,
                "ms": round((time.time() - t0) * 1000), "code": "network",
                "detail": str(exc)[:70], "title": title, "hint": hint}


def _src(src: dict) -> dict:
    return {"id": src["id"], "label": src["label"]}


@app.get("/api/upstream")
def upstream():
    """Are the data sources answering *this machine* right now."""
    results = [probe_one(s) for s in UPSTREAM]
    worst = "pass"
    for r in results:
        if r["status"] == "error":
            worst = "error"
        elif r["status"] == "warn" and worst == "pass":
            worst = "warn"
    blocked = [r for r in results if r.get("code") == "rate_limited"]
    return {
        "status": worst,
        "checkedAt": _iso(time.time()),
        "sources": results,
        "canSync": not blocked,
        "summary": (f"{blocked[0]['label'].split(' (')[0]} is rate-limiting this IP"
                    if blocked else
                    "all sources answering" if worst == "pass" else
                    "some sources degraded"),
    }


@app.post("/api/sync")
async def start_sync(req: SyncRequest):
    """
    Bring stored prices up to today. `since` defaults to the manifest's
    history start so the refreshed window always covers every bar the
    dashboard can display.
    """
    running = JOBS.current_id()
    if running:
        raise HTTPException(409, f"a sync is already running ({running})")

    markets = [m.upper() for m in req.markets if m.upper() in ("US", "TR")]
    if not markets:
        raise HTTPException(400, "markets must contain US and/or TR")

    manifest = read_manifest() or {}
    since = req.since or manifest.get("historyStart") or "2026-01-01"
    try:
        date.fromisoformat(since)
    except ValueError:
        raise HTTPException(400, f"since must be YYYY-MM-DD, got {since!r}")

    job = JOBS.create(markets, since)
    asyncio.create_task(_run_sync(job, markets, since, req.limit))
    return job_view(job)


@app.get("/api/sync/{job_id}")
def sync_job(job_id: str, tail: int = 60):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    return job_view(job, tail)


@app.get("/api/jobs")
def jobs():
    return {"running": JOBS.current_id(), "recent": JOBS.recent()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("control_plane.main:app", host="127.0.0.1", port=8000, reload=False)
