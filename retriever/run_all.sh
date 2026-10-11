#!/usr/bin/env bash
# Staged retrieval of the FULL universe. Each stage adds one resolution and is resumable, so the
# dashboard is usable after stage 1 and gets richer as later stages land.
set -u
cd "$(dirname "$0")"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36"

wait_for_yahoo() {
  for i in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d" \
      -H "User-Agent: $UA" -H "Referer: https://finance.yahoo.com/")
    if [ "$code" = "200" ]; then echo "[gate] Yahoo reachable (attempt $i)"; return 0; fi
    echo "[gate] HTTP $code -- waiting 30s (attempt $i)"
    sleep 30
  done
  echo "[gate] still throttled after 60 min"; return 1
}

wait_for_yahoo || exit 1

echo "=== stage 1/2: daily history (both markets + BIST candidate probe) ==="
python3 -u fetch_etfs.py --intervals 1d --workers 3 --pause 0.45 --probe-candidates

echo "=== stage 2/2: hourly (feeds 1h/3h/4h/8h) ==="
python3 -u fetch_etfs.py --intervals 1d 1h --workers 3 --pause 0.45

python3 -u fetch_etfs.py --rebuild-manifest
echo "=== ALL STAGES DONE ==="
du -sh ../web/data 2>/dev/null
