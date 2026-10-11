#!/usr/bin/env bash
# Representative sample: both base resolutions (1h + 1d) for a handful of
# ETFs per market. Swap in run_all.sh for the complete universe.
set -u
cd "$(dirname "$0")"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36"
US="SPY QQQ IWM XLK SMH GLD TLT ARKK TUR"
TR="ZPX30 ISX30 GLDTR APGLD ZPLIB ZTM25 ISGLK Z30KE"

for i in $(seq 1 150); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
    "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d" \
    -H "User-Agent: $UA" -H "Referer: https://finance.yahoo.com/")
  [ "$code" = "200" ] && { echo "[gate] Yahoo reachable (attempt $i)"; break; }
  echo "[gate] HTTP $code -- waiting 25s (attempt $i)"; sleep 25
done

echo "=== pass 1: daily ==="
python3 -u fetch_etfs.py --intervals 1d --workers 2 --pause 0.6 --only $US $TR
echo "=== pass 2: hourly ==="
python3 -u fetch_etfs.py --intervals 1d 1h --workers 2 --pause 0.6 --only $US $TR
python3 -u fetch_etfs.py --rebuild-manifest
echo "=== SAMPLE DONE ==="; du -sh ../web/data
