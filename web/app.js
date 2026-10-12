/* =====================================================================
   Bourse ETF Terminal
   ---------------------------------------------------------------------
   Static front end over the JSON the Python retriever writes. One base
   resolution ships with the data (1d); every coarser step is resampled
   here, in the browser, so the whole terminal runs with no server and
   no API key.
   ===================================================================== */
'use strict';

const DATA = 'data/';
const LWC = window.LightweightCharts;

/* ------------------------------------------------------------- timeframes */
/* `base` is the stored resolution a step is built from; `mode`/`n` is the
   bucketing rule applied to it. Bucket boundaries are computed in
   exchange-local time so a "1D" bar is a real trading day in Istanbul or
   New York, not a UTC day. One day is the smallest step. */
const TF = [
  { id: '1d', label: '1D', base: '1d', mode: 'none' },
  { id: '3d', label: '3D', base: '1d', mode: 'day', n: 3 },
  { id: '1w', label: '1W', base: '1d', mode: 'week', n: 1 },
  { id: '2w', label: '2W', base: '1d', mode: 'week', n: 2 },
  { id: '3w', label: '3W', base: '1d', mode: 'week', n: 3 },
  { id: '1M', label: '1M', base: '1d', mode: 'month', n: 1 },
  { id: '3M', label: '3M', base: '1d', mode: 'month', n: 3 },
  { id: '6M', label: '6M', base: '1d', mode: 'month', n: 6 },
  { id: '1Y', label: '1Y', base: '1d', mode: 'month', n: 12 },
];
const TF_BY_ID = Object.fromEntries(TF.map(t => [t.id, t]));
const INTRADAY = new Set();   // no sub-daily step is offered

/* ----------------------------------------------------------------- ranges */
const RANGES = [
  { id: '5d', label: '5D', days: 5 },
  { id: '1mo', label: '1M', days: 31 },
  { id: '3mo', label: '3M', days: 92 },
  { id: '6mo', label: '6M', days: 183 },
  { id: 'ytd', label: 'YTD 2026', ytd: true },
  { id: '1y', label: '1Y', days: 365 },
  { id: '2y', label: '2Y', days: 730 },
  { id: 'max', label: 'Max', max: true },
  { id: 'custom', label: 'Custom', custom: true },
];
const YTD_START = Date.UTC(2026, 0, 1) / 1000;

/* The universe runs to a couple of thousand funds. Every row carries an
   inline sparkline, so rendering all of them costs more than it is worth:
   nobody scrolls two thousand rows, they search. Render the top slice of
   the current sort and say so. */
const LIST_RENDER_CAP = 250;

/* Opening on the alphabetically first of two thousand funds lands you on
   something nobody has heard of. Prefer a bellwether when the market has
   one. */
const OPENING_PICK = { US: ['SPY', 'QQQ', 'VOO'], TR: ['ZTM', 'ZPX30', 'ZBB'] };
function openingFund(market) {
  const rows = S.rows[market] || [];
  for (const want of OPENING_PICK[market] || []) {
    const hit = rows.find(e => e.d === want);
    if (hit) return hit;
  }
  return rows[0];
}

/* Sparklines arrive as one character per point (see encode_spark in
   fetch_etfs.py). The chart normalises anyway, so the decoded ordinals are
   usable as-is. */
let SPARK_ALPHA = '';
function decodeSpark(str) {
  if (!str) return null;
  const out = new Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = SPARK_ALPHA.indexOf(str[i]);
  return out;
}

const STYLES = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
];

const SESSIONS = {
  'America/New_York': { label: 'New York', open: 9 * 60 + 30, close: 16 * 60 },
  'Europe/Istanbul': { label: 'Istanbul', open: 10 * 60, close: 18 * 60 },
};

/* ------------------------------------------------------------------ state */
const S = {
  manifest: null,
  rows: {},             // market -> fund rows, fetched the first time it is shown
  market: 'US',
  symbol: null,
  etf: null,            // loaded record for S.symbol
  cache: new Map(),     // symbol -> record
  range: 'ytd',
  tf: '1d',
  style: 'candles',
  overlays: { sma20: false, sma50: false, vol: true },
  custom: { from: '2026-01-01', to: isoDay(new Date()) },
  sort: { key: 'display', dir: 1 },
  filter: '',
  category: '',
  theme: '',             // specific theme filter, e.g. 'Semiconductors'
  themes: null,          // themes.json, loaded once
  bars: [],             // current resampled window
  loading: false,
};

/* ------------------------------------------------------------- formatting */
const nf = (v, d = 2) => v == null || !isFinite(v) ? '—'
  : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pf = v => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const sign = v => v == null || !isFinite(v) ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat';

function volFmt(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
function isoDay(d) { return d.toISOString().slice(0, 10); }
/* local-shifted seconds -> display string (already in exchange-local terms) */
function fmtLocal(ls, withTime) {
  const d = new Date(ls * 1000);
  const p = n => String(n).padStart(2, '0');
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : day;
}
function decimals(price) { return price >= 500 ? 2 : price >= 20 ? 2 : price >= 1 ? 3 : 4; }

/* ------------------------------------------------------------- resampling */
function bucketStart(ls, tf) {
  switch (tf.mode) {
    case 'sec':
      return Math.floor(ls / tf.n) * tf.n;
    case 'day': {
      const d = Math.floor(ls / 86400);
      return Math.floor(d / tf.n) * tf.n * 86400;
    }
    case 'week': {                       // epoch day 4 = Mon 1970-01-05
      const d = Math.floor(ls / 86400);
      const w = Math.floor((d - 4) / 7);
      return (Math.floor(w / tf.n) * tf.n * 7 + 4) * 86400;
    }
    case 'month': {
      const d = new Date(ls * 1000);
      const mi = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const b = Math.floor(mi / tf.n) * tf.n;
      return Date.UTC(Math.floor(b / 12), b % 12, 1) / 1000;
    }
    default:
      return ls;
  }
}

/* Build the window the whole UI reads from: range-filtered, then bucketed.
   Each bar carries `t` (true UTC) for export and `lt` (exchange-local
   shifted) for the chart axis and on-screen labels. */
function buildBars(etf, tfId, from, to) {
  const tf = TF_BY_ID[tfId];
  const base = etf.series[tf.base];
  if (!base) return [];
  const gmt = etf.gmtoffset || 0;
  const { t, o, h, l, c, v } = base;
  const out = [];
  let cur = null;

  for (let i = 0; i < t.length; i++) {
    const ts = t[i];
    if (from != null && ts < from) continue;
    if (to != null && ts > to) break;
    const ls = ts + gmt;

    if (tf.mode === 'none') {
      out.push({ t: ts, lt: ls, o: o[i], h: h[i], l: l[i], c: c[i], v: v[i], n: 1 });
      continue;
    }
    const key = bucketStart(ls, tf);
    if (!cur || cur.lt !== key) {
      cur = { t: key - gmt, lt: key, o: o[i], h: h[i], l: l[i], c: c[i], v: v[i], n: 1 };
      out.push(cur);
    } else {
      if (h[i] > cur.h) cur.h = h[i];
      if (l[i] < cur.l) cur.l = l[i];
      cur.c = c[i];
      cur.v += v[i];
      cur.n++;
    }
  }
  return out;
}

function rangeBounds() {
  const r = RANGES.find(x => x.id === S.range);
  const now = Math.floor(Date.now() / 1000);
  if (r.custom) {
    const f = Date.parse(S.custom.from + 'T00:00:00Z') / 1000;
    const t = Date.parse(S.custom.to + 'T23:59:59Z') / 1000;
    return [isFinite(f) ? f : null, isFinite(t) ? t : null];
  }
  if (r.max) return [null, null];
  if (r.ytd) return [YTD_START, null];
  return [now - r.days * 86400, null];
}

/* ------------------------------------------------------------- indicators */
function sma(bars, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= n) sum -= bars[i - n].c;
    if (i >= n - 1) out.push({ time: bars[i].lt, value: sum / n });
  }
  return out;
}

function analytics(bars) {
  if (!bars.length) return null;
  const first = bars[0], last = bars[bars.length - 1];
  let hi = -Infinity, lo = Infinity, hiAt = null, loAt = null, vol = 0;
  for (const b of bars) {
    if (b.h > hi) { hi = b.h; hiAt = b.lt; }
    if (b.l < lo) { lo = b.l; loAt = b.lt; }
    vol += b.v;
  }
  // annualised volatility of log returns; bars/year measured from the data
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0 && bars[i].c > 0) rets.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  let sigma = null;
  if (rets.length > 2) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
    const span = (last.t - first.t) / 31557600;                 // years covered
    const perYear = span > 0 ? bars.length / span : 252;
    sigma = Math.sqrt(varr) * Math.sqrt(perYear) * 100;
  }
  // max drawdown on closes
  let peak = -Infinity, mdd = 0;
  for (const b of bars) { if (b.c > peak) peak = b.c; if (peak > 0) mdd = Math.min(mdd, b.c / peak - 1); }

  return {
    open: first.o, high: hi, low: lo, close: last.c, hiAt, loAt,
    ret: first.o > 0 ? (last.c / first.o - 1) * 100 : null,
    sigma, mdd: mdd * 100, vol, avgVol: vol / bars.length,
    bars: bars.length, from: first.lt, to: last.lt,
  };
}

/* ------------------------------------------------------------------ chart */
const CH = { chart: null, price: null, volume: null, ov: {}, ro: null };

function chartTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = k => cs.getPropertyValue(k).trim();
  return {
    text: g('--text-2'), grid: g('--grid'), line: g('--line'),
    up: g('--up'), down: g('--down'), accent: g('--accent'), panel: g('--panel'),
  };
}

function buildChart() {
  const el = document.getElementById('chart');
  if (!el || !LWC) return;
  const T = chartTheme();
  CH.chart = LWC.createChart(el, {
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: T.text,
              fontFamily: '"Playfair Display", Georgia, serif', fontSize: 12 },
    grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
    rightPriceScale: { borderColor: T.line, scaleMargins: { top: 0.08, bottom: 0.26 } },
    timeScale: { borderColor: T.line, rightOffset: 4, barSpacing: 8,
                 timeVisible: true, secondsVisible: false },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: T.accent, width: 1, style: 2, labelBackgroundColor: T.accent },
      horzLine: { color: T.accent, width: 1, style: 2, labelBackgroundColor: T.accent },
    },
    localization: { locale: 'en-US' },
    handleScale: { axisPressedMouseMove: { time: true, price: true } },
    autoSize: true,
  });
  CH.chart.subscribeCrosshairMove(onCrosshair);

  // Re-fit when the pane changes width: the chart is created before the
  // grid has settled, so the first fit can land against a stale width.
  if (window.ResizeObserver) {
    let w = el.clientWidth;
    CH.ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - w) < 2) return;
      w = el.clientWidth;
      fitSoon();
    });
    CH.ro.observe(el);
  }
}

function applyChartTheme() {
  if (!CH.chart) return;
  const T = chartTheme();
  CH.chart.applyOptions({
    layout: { textColor: T.text },
    grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
    rightPriceScale: { borderColor: T.line },
    timeScale: { borderColor: T.line },
    crosshair: {
      vertLine: { color: T.accent, labelBackgroundColor: T.accent },
      horzLine: { color: T.accent, labelBackgroundColor: T.accent },
    },
  });
  drawSeries();
}

function clearSeries() {
  for (const s of [CH.price, CH.volume, CH.ov.sma20, CH.ov.sma50]) {
    if (s) { try { CH.chart.removeSeries(s); } catch (_) {} }
  }
  CH.price = CH.volume = null; CH.ov = {};
}

function drawSeries(keepView) {
  if (!CH.chart) return;
  const T = chartTheme();
  const bars = S.bars;
  const d = decimals(bars.length ? bars[bars.length - 1].c : 100);
  const pf_ = { type: 'price', precision: d, minMove: Math.pow(10, -d) };
  const view = keepView ? CH.chart.timeScale().getVisibleLogicalRange() : null;

  clearSeries();
  if (!bars.length) return;

  if (S.overlays.vol && !isNav(S.etf)) {
    CH.volume = CH.chart.addHistogramSeries({
      priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false,
      lastValueVisible: false,
    });
    CH.chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 }, visible: false,
    });
    CH.volume.setData(bars.map(b => ({
      time: b.lt, value: b.v,
      color: b.c >= b.o ? withAlpha(T.up, .34) : withAlpha(T.down, .34),
    })));
  }

  const common = { priceFormat: pf_, priceLineColor: T.accent, priceLineStyle: 2 };
  if (S.style === 'candles' || S.style === 'hollow') {
    CH.price = CH.chart.addCandlestickSeries({
      ...common,
      upColor: S.style === 'hollow' ? 'rgba(0,0,0,0)' : T.up,
      downColor: T.down, borderUpColor: T.up, borderDownColor: T.down,
      wickUpColor: T.up, wickDownColor: T.down,
    });
    CH.price.setData(bars.map(b => ({ time: b.lt, open: b.o, high: b.h, low: b.l, close: b.c })));
  } else if (S.style === 'bars') {
    CH.price = CH.chart.addBarSeries({ ...common, upColor: T.up, downColor: T.down, thinBars: false });
    CH.price.setData(bars.map(b => ({ time: b.lt, open: b.o, high: b.h, low: b.l, close: b.c })));
  } else if (S.style === 'line') {
    CH.price = CH.chart.addLineSeries({ ...common, color: T.accent, lineWidth: 2 });
    CH.price.setData(bars.map(b => ({ time: b.lt, value: b.c })));
  } else {
    const rising = bars[bars.length - 1].c >= bars[0].o;
    const col = rising ? T.up : T.down;
    CH.price = CH.chart.addAreaSeries({
      ...common, lineColor: col, lineWidth: 2,
      topColor: withAlpha(col, .26), bottomColor: withAlpha(col, 0),
    });
    CH.price.setData(bars.map(b => ({ time: b.lt, value: b.c })));
  }

  for (const [key, n, color] of [['sma20', 20, T.accent], ['sma50', 50, T.text]]) {
    if (!S.overlays[key] || bars.length < n) continue;
    CH.ov[key] = CH.chart.addLineSeries({
      color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, priceFormat: pf_,
    });
    CH.ov[key].setData(sma(bars, n));
  }

  CH.chart.applyOptions({
    timeScale: { timeVisible: INTRADAY.has(S.tf), secondsVisible: false },
  });
  if (view) CH.chart.timeScale().setVisibleLogicalRange(view);
  else { CH.chart.timeScale().fitContent(); fitSoon(); }
  renderLegend(bars[bars.length - 1]);
}

function fitSoon() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (CH.chart) CH.chart.timeScale().fitContent();
  }));
}

function withAlpha(color, a) {
  const c = color.trim();
  if (c.startsWith('#')) {
    const n = c.length === 4
      ? c.slice(1).split('').map(x => parseInt(x + x, 16))
      : [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    return `rgba(${n[0]},${n[1]},${n[2]},${a})`;
  }
  return c;
}

function onCrosshair(param) {
  if (!param || !param.time) { renderLegend(S.bars[S.bars.length - 1]); return; }
  const bar = S.bars.find(b => b.lt === param.time);
  renderLegend(bar || S.bars[S.bars.length - 1]);
}

function renderLegend(bar) {
  const el = document.getElementById('legend');
  if (!el) return;
  if (!bar) { el.textContent = ''; return; }
  const d = decimals(bar.c);
  const dir = bar.c >= bar.o ? 'up' : 'down';
  const chg = bar.o > 0 ? (bar.c / bar.o - 1) * 100 : null;
  el.innerHTML = `
    <span class="lg-t">${fmtLocal(bar.lt, INTRADAY.has(S.tf))}</span>
    <span><b>O</b>${nf(bar.o, d)}</span>
    <span><b>H</b>${nf(bar.h, d)}</span>
    <span><b>L</b>${nf(bar.l, d)}</span>
    <span><b>C</b><span class="${dir}">${nf(bar.c, d)}</span></span>
    <span class="${dir}">${pf(chg)}</span>
    <span><b>Vol</b>${volFmt(bar.v)}</span>`;
}

/* ------------------------------------------------------------------ export */
function exportRows() {
  const etf = S.etf, bars = S.bars;
  const tf = TF_BY_ID[S.tf];
  const withTime = INTRADAY.has(S.tf);
  const head = ['#', `Period start (${etf.timezone || 'exchange local'})`,
    'Open', 'High', 'Low', 'Close', 'Change', 'Change %', 'Volume', 'UTC (ISO 8601)'];
  const rows = bars.map((b, i) => {
    const prev = i ? bars[i - 1].c : null;
    return [
      i + 1,
      fmtLocal(b.lt, withTime),
      b.o, b.h, b.l, b.c,
      prev == null ? null : +(b.c - prev).toFixed(6),
      prev ? +((b.c / prev - 1) * 100).toFixed(4) : null,
      b.v,
      new Date(b.t * 1000).toISOString(),
    ];
  });
  return { head, rows, tf };
}

function summaryRows(a) {
  const etf = S.etf, tf = TF_BY_ID[S.tf];
  const r = RANGES.find(x => x.id === S.range);
  const d = decimals(a ? a.close : 100);
  return [
    ['Bourse ETF Terminal — price history export'],
    [],
    ['Symbol', etf.symbol],
    ['Name', etf.name],
    ['Market', etf.market === 'US' ? 'United States' : 'Türkiye'],
    ['Exchange', etf.exchange || '—'],
    ['Currency', etf.currency],
    ['Category', etf.category],
    ['Theme', etf.theme || '—'],
    [],
    ['Time step', tf.label],
    ['Period selected', r.custom ? `${S.custom.from} → ${S.custom.to}` : r.label],
    ['Bars returned', a ? a.bars : 0],
    ['First bar (exchange local)', a ? fmtLocal(a.from, INTRADAY.has(S.tf)) : '—'],
    ['Last bar (exchange local)', a ? fmtLocal(a.to, INTRADAY.has(S.tf)) : '—'],
    [],
    ['Period open', a ? +a.open.toFixed(d) : null],
    ['Period high', a ? +a.high.toFixed(d) : null],
    ['Period low', a ? +a.low.toFixed(d) : null],
    ['Period close', a ? +a.close.toFixed(d) : null],
    ['Period return %', a && a.ret != null ? +a.ret.toFixed(4) : null],
    ['Annualised volatility %', a && a.sigma != null ? +a.sigma.toFixed(4) : null],
    ['Max drawdown %', a ? +a.mdd.toFixed(4) : null],
    ['Total volume', a ? a.vol : null],
    [],
    ['Base resolution stored', tf.base],
    ['Price basis', etf.priceType === 'nav'
      ? 'daily net asset value published by TEFAS (no intraday range, no volume)'
      : 'last traded price'],
    ['Daily series origin', etf.dailySource === 'tefas'
      ? `TEFAS fund ${etf.tefasCode}`
      : etf.dailySource === '1h'
      ? 'aggregated from hourly bars (the venue publishes no daily series through this feed)'
      : 'as published by the feed'],
    ['Resampling', tf.mode === 'none'
      ? 'none — bars as retrieved'
      : `OHLCV aggregation of ${tf.base} bars into ${tf.label} buckets (open=first, high=max, low=min, close=last, volume=sum), bucketed in exchange-local time`],
    ['Data source', 'Yahoo Finance public chart endpoint (no API key)'],
    ['Retrieved at (UTC)', etf.fetchedAt || '—'],
    ['Exported at (UTC)', new Date().toISOString()],
  ];
}

function buildWorkbook() {
  const { head, rows } = exportRows();
  const a = analytics(S.bars);
  const wb = XLSX.utils.book_new();

  const prices = XLSX.utils.aoa_to_sheet([head, ...rows]);
  prices['!cols'] = [{ wch: 6 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
                     { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 15 }, { wch: 24 }];
  prices['!freeze'] = { xSplit: 0, ySplit: 1 };
  prices['!autofilter'] = { ref: XLSX.utils.encode_range(
    { s: { r: 0, c: 0 }, e: { r: rows.length, c: head.length - 1 } }) };
  const d = decimals(a ? a.close : 100);
  const priceFmt = '#,##0.' + '0'.repeat(d);
  for (let r = 1; r <= rows.length; r++) {
    for (const c of [2, 3, 4, 5, 6]) {
      const cell = prices[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') cell.z = priceFmt;
    }
    const pc = prices[XLSX.utils.encode_cell({ r, c: 7 })];
    if (pc && typeof pc.v === 'number') pc.z = '+0.00;-0.00';
    const vc = prices[XLSX.utils.encode_cell({ r, c: 8 })];
    if (vc && typeof vc.v === 'number') vc.z = '#,##0';
  }
  XLSX.utils.book_append_sheet(wb, prices, 'Prices');

  const summ = XLSX.utils.aoa_to_sheet(summaryRows(a));
  summ['!cols'] = [{ wch: 30 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, summ, 'Summary');

  return wb;
}

function fileStem() {
  const r = RANGES.find(x => x.id === S.range);
  const a = analytics(S.bars);
  const span = a ? `${fmtLocal(a.from, false)}_${fmtLocal(a.to, false)}`
                 : (r.custom ? `${S.custom.from}_${S.custom.to}` : r.id);
  return `${S.etf.display}_${S.etf.market}_${TF_BY_ID[S.tf].label}_${span}`;
}

async function deliver(filename, blob) {
  if (window.claude && typeof window.claude.use === 'function') {
    let dl = null;
    try { dl = await window.claude.use('downloads'); } catch (_) { dl = null; }
    if (dl) {
      try {
        await dl.save({ filename, data: blob });
        return { ok: true, msg: `Saved ${filename}` };
      } catch (err) {
        const code = err && err.code;
        if (code === 'declined') return { ok: false, msg: 'Download cancelled.' };
        if (code === 'rate_limited') return { ok: false, msg: 'A save prompt is already open — finish that one first.' };
        if (code === 'too_large') return { ok: false, msg: 'File too large for this viewer. Narrow the period or use a coarser step.' };
        /* anything else: fall through to the plain browser download */
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, msg: `Downloaded ${filename}` };
}

/* SheetJS is ~880 KB and only earns its place when someone actually
   exports, so it is fetched on the first click rather than on every page
   load. */
let xlsxReady = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (xlsxReady) return xlsxReady;
  xlsxReady = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    el.onload = () => resolve();
    el.onerror = () => { xlsxReady = null; reject(new Error('spreadsheet library failed to load')); };
    document.head.appendChild(el);
  });
  return xlsxReady;
}

async function doExport(kind) {
  const msg = document.getElementById('exMsg');
  const setMsg = (t, s) => { if (msg) { msg.textContent = t; msg.dataset.s = s || ''; } };
  if (!S.bars.length) { setMsg('Nothing to export for this period and step.', 'err'); return; }
  setMsg('Building file…');
  try {
    let blob, name;
    if (kind === 'csv') {
      const { head, rows } = exportRows();
      const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
      const csv = [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
      blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      name = fileStem() + '.csv';
    } else {
      await loadXlsx();
      const out = XLSX.write(buildWorkbook(), { bookType: 'xlsx', type: 'array' });
      blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      name = fileStem() + '.xlsx';
    }
    const res = await deliver(name, blob);
    setMsg(res.msg, res.ok ? 'ok' : 'err');
  } catch (err) {
    setMsg('Export failed: ' + (err && err.message ? err.message : String(err)), 'err');
  }
}

/* ===================================================================== */
/*                               rendering                               */
/* ===================================================================== */

function shellHTML() {
  return `
  <header class="rail">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">Bourse</span>
      <span class="brand-sub">ETF Terminal</span>
    </div>
    <div class="clocks" id="clocks"></div>
    <div class="rail-right">
      <div class="asof"><span class="eyebrow">Data as of</span><b id="asof">—</b></div>
      <button class="icon-btn" id="themeBtn" title="Switch theme" aria-label="Switch theme">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="3.4"/><path d="M8 .9v2M8 13.1v2M.9 8h2M13.1 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"/>
        </svg>
      </button>
    </div>
  </header>

  <div class="shell">
    <aside class="pane list-pane">
      <div class="mtabs" role="tablist" id="mtabs"></div>
      <div class="list-tools">
        <input class="search" id="search" type="search" placeholder="Filter ticker or name" aria-label="Filter instruments">
        <select class="sel" id="catSel" aria-label="Filter by category"></select>
      </div>
      <div class="theme-bar" id="themeBar"></div>
      <div class="lhead">
        <button data-sort="display">Instrument</button>
        <button data-sort="last">Last</button>
        <button data-sort="chgPct">Chg %</button>
        <span class="eyebrow" style="text-align:right">60d</span>
      </div>
      <div class="list" id="list" role="listbox" aria-label="ETF list"></div>
      <div class="list-foot" id="listFoot"></div>
    </aside>

    <section class="pane ws" id="ws"></section>
  </div>

  <footer class="foot">
    <strong>Bourse ETF Terminal</strong> — price history for the United States and Borsa İstanbul ETF markets.
    Prices retrieved with <code>retriever/fetch_etfs.py</code> from Yahoo Finance's public chart endpoint (no API key, no account).
    One resolution is stored per fund — <code>1d</code> — and every coarser step is resampled in the browser
    (open = first, high = max, low = min, close = last, volume = sum), bucketed in exchange-local time.
    Figures are unadjusted last-traded prices for study and coursework, not investment advice.
  </footer>`;
}

function wsHTML() {
  return `
  <div class="ihead">
    <div class="ident">
      <div class="ident-top">
        <span class="ticker" id="iTicker">—</span>
        <span class="chip chip-mkt" id="iMkt">—</span>
        <span class="chip" id="iCat">—</span>
        <span class="chip" id="iTheme" hidden></span>
        <span class="chip" id="iClass" hidden></span>
      </div>
      <div class="ident-nm" id="iName">—</div>
      <div class="ident-meta" id="iMeta"></div>
    </div>
    <div class="quote">
      <div><span class="q-cur" id="qCur"></span><span class="q-last num" id="qLast">—</span></div>
      <div class="q-chg" id="qChg"></div>
      <div class="q-sub" id="qSub"></div>
    </div>
  </div>

  <div class="ctl">
    <div class="ctl-grp">
      <span class="eyebrow">Period</span>
      <div class="segs" id="segRange"></div>
    </div>
    <div class="ctl-grp" id="customWrap" hidden>
      <span class="eyebrow">From / to</span>
      <div class="dates">
        <input type="date" id="dFrom"><span>→</span><input type="date" id="dTo">
      </div>
    </div>
    <div class="ctl-grp">
      <span class="eyebrow">Time step <span style="color:var(--text-2)">· 1 day minimum</span></span>
      <div class="segs" id="segTf"></div>
    </div>
    <div class="ctl-grp">
      <span class="eyebrow">Chart</span>
      <div class="segs" id="segStyle"></div>
    </div>
    <div class="ctl-grp">
      <span class="eyebrow">Overlay</span>
      <div class="segs" id="segOv"></div>
    </div>
  </div>

  <p class="chart-note" id="chartNote" hidden></p>

  <div class="chart-shell">
    <div class="legend" id="legend"></div>
    <div class="chart" id="chart"></div>
  </div>

  <div class="stats" id="stats"></div>

  <div class="export">
    <div class="export-top">
      <h2>Export this window</h2>
      <p>The workbook contains exactly the bars drawn above — the period and time step you selected —
         plus a Summary sheet recording the source, the resampling rule and the period statistics.</p>
    </div>
    <div class="export-grid" id="exGrid"></div>
    <div class="btns">
      <button class="btn btn-primary" id="btnXlsx">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M8 1.6v8.2M4.8 7l3.2 3.2L11.2 7M2.2 13.2h11.6"/>
        </svg>Download Excel (.xlsx)</button>
      <button class="btn" id="btnCsv">Download CSV</button>
      <span class="ex-msg" id="exMsg"></span>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ clocks */
function renderClocks() {
  const el = document.getElementById('clocks');
  if (!el) return;
  const now = new Date();
  el.innerHTML = Object.entries(SESSIONS).map(([tz, s]) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hour12: false,
    }).formatToParts(now);
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    const hh = +get('hour'), mm = +get('minute');
    const wd = get('weekday');
    const mins = hh * 60 + mm;
    const weekday = !['Sat', 'Sun'].includes(wd);
    const open = weekday && mins >= s.open && mins < s.close;
    return `<div class="clock">
      <span class="sess" data-open="${open ? 1 : 0}" title="${open ? 'Session open' : 'Session closed'}"></span>
      <span class="clock-city">${s.label}</span>
      <span class="clock-time">${get('hour')}:${get('minute')}:${get('second')}</span>
    </div>`;
  }).join('');
}

/* -------------------------------------------------------------- market tabs */
function renderTabs() {
  const el = document.getElementById('mtabs');
  el.innerHTML = ['US', 'TR'].map(m => {
    const mk = S.manifest.markets[m];
    const on = S.market === m;
    return `<button class="mtab" role="tab" data-market="${m}" aria-selected="${on}">
      <span class="mtab-code">${m === 'US' ? 'United States' : 'Türkiye'}</span>
      <span class="mtab-label">${mk ? `${mk.count} funds · ${mk.venue}` : 'no data'}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('.mtab').forEach(b => b.onclick = async () => {
    const m = b.dataset.market;
    if (!S.manifest.markets[m] || m === S.market) return;
    S.market = m; S.category = ''; S.theme = ''; S.filter = '';
    const box = document.getElementById('search'); if (box) box.value = '';
    renderTabs(); renderCats();
    await ensureRows(m);
    renderList();
    const opening = openingFund(m);
    if (opening) select(opening.s);
  });
}

/* One control, two levels: pick a whole category or a single theme inside
   it. Themes are what cross-fund comparison works in, so they are the
   selectable leaves rather than a second dropdown to hunt through. */
function renderCats() {
  const sel = document.getElementById('catSel');
  const mk = S.manifest.markets[S.market];
  if (!mk) { sel.innerHTML = ''; return; }
  const byCat = mk.themesByCategory || {};
  const counts = {};
  for (const e of (S.rows[S.market] || [])) counts[e.h] = (counts[e.h] || 0) + 1;

  let html = `<option value="">All sectors &amp; themes</option>`;
  for (const cat of (mk.categories || [])) {
    html += `<optgroup label="${cat}">`;
    html += `<option value="c:${cat}"${S.category === cat && !S.theme ? ' selected' : ''}>All ${cat}</option>`;
    for (const th of (byCat[cat] || [])) {
      const n = counts[th] || 0;
      html += `<option value="t:${th}"${S.theme === th ? ' selected' : ''}>${th} (${n})</option>`;
    }
    html += `</optgroup>`;
  }
  sel.innerHTML = html;
}

/* -------------------------------------------------------------- instrument list */
const SORT_FIELD = { display: 'd', last: 'l', chgPct: 'p' };

function visibleEtfs() {
  const rows = S.rows[S.market];
  if (!rows) return [];
  const q = S.filter.trim().toLowerCase();
  const list = rows.filter(e =>
    (!S.theme || e.h === S.theme) &&
    (!S.category || e.c === S.category) &&
    (!q || e.d.toLowerCase().includes(q) || (e.n || '').toLowerCase().includes(q)));
  const key = SORT_FIELD[S.sort.key] || 'd';
  const dir = S.sort.dir;
  list.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return ((av ?? -Infinity) - (bv ?? -Infinity)) * dir;
  });
  return list;
}

async function ensureThemes() {
  if (S.themes) return S.themes;
  try {
    const res = await fetch(DATA + 'themes.json', { cache: 'default' });
    S.themes = res.ok ? (await res.json()).themes : [];
  } catch (_) {
    S.themes = [];
  }
  return S.themes;
}

/* With a theme selected the list stops being a list of funds and becomes a
   peer group, so show how that group is doing rather than making someone
   open its members one at a time. */
function renderThemeBar() {
  const el = document.getElementById('themeBar');
  if (!el) return;
  if (!S.theme || !S.themes) { el.dataset.on = '0'; return; }
  const t = S.themes.find(x => x.market === S.market && x.theme === S.theme);
  if (!t) { el.dataset.on = '0'; return; }
  el.dataset.on = '1';
  const cell = (k, v, cls) =>
    `<div class="tb"><div class="tb-k">${k}</div><div class="tb-v ${cls || ''}">${v}</div></div>`;
  el.innerHTML =
    `<div class="theme-bar-name">${t.theme} · ${t.count} funds</div>
     <div class="theme-bar-grid">
       ${cell('Median YTD', pf(t.medianYtdPct), sign(t.medianYtdPct))}
       ${cell('Best', pf(t.bestYtdPct), sign(t.bestYtdPct))}
       ${cell('Worst', pf(t.worstYtdPct), sign(t.worstYtdPct))}
     </div>` + (t.flagged
       ? `<div class="tb-k" style="margin-top:6px;color:var(--down)">${t.flagged} fund${t.flagged > 1 ? 's' : ''} excluded — reporting break</div>`
       : '');
}

async function ensureRows(market) {
  if (S.rows[market]) return S.rows[market];
  const mk = S.manifest.markets[market];
  const res = await fetch(DATA + mk.rows, { cache: 'default' });
  if (!res.ok) throw new Error(`${mk.rows}: HTTP ${res.status}`);
  S.rows[market] = await res.json();
  return S.rows[market];
}

function sparkline(vals, up) {
  if (!vals || vals.length < 2) return '';
  const w = 46, h = 20, pad = 2;
  const lo = Math.min(...vals), hi = Math.max(...vals), rng = hi - lo || 1;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - lo) / rng) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const col = up ? 'var(--up)' : 'var(--down)';
  return `<svg class="row-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.2"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${pts[pts.length - 1].split(',')[0]}" cy="${pts[pts.length - 1].split(',')[1]}" r="1.5" fill="${col}"/>
  </svg>`;
}

function rowHTML(e) {
  const s = sign(e.p);
  const d = decimals(e.l);
  const on = e.s === S.symbol;
  return `<button class="row" role="option" data-sym="${e.s}"
            aria-current="${on}" aria-selected="${on}">
    <span class="row-id">
      <span class="row-tic">${e.d}</span>
      <span class="row-nm">${e.n || ''}</span>
    </span>
    <span class="row-last">${nf(e.l, d)}</span>
    <span class="row-chg" data-s="${s === 'up' ? 'u' : s === 'down' ? 'd' : ''}"
      ${e.x ? 'title="reporting break in this fund\u2019s price series"' : ''}>${e.x ? '⚠' : pf(e.p)}</span>
    ${sparkline(decodeSpark(e.k), (e.y ?? e.p ?? 0) >= 0)}
  </button>`;
}

function renderList() {
  const el = document.getElementById('list');
  const all = visibleEtfs();
  const rows = all.slice(0, LIST_RENDER_CAP);
  el.innerHTML = rows.length ? rows.map(rowHTML).join('') : `<div style="padding:26px 12px;text-align:center;color:var(--text-3);font-size:12px">No funds match that filter.</div>`;

  el.querySelectorAll('.row').forEach(b => b.onclick = () => select(b.dataset.sym));
  if (S.symbol && !rows.some(e => e.s === S.symbol)) {
    const cur = all.find(e => e.s === S.symbol);
    if (cur) el.insertAdjacentHTML('afterbegin', rowHTML(cur));
    const first = el.querySelector('.row');
    if (first && first.dataset.sym === S.symbol) {
      first.onclick = () => select(S.symbol);
    }
  }

  document.querySelectorAll('.lhead [data-sort]').forEach(b => {
    const on = b.dataset.sort === S.sort.key;
    if (on) b.setAttribute('aria-sort', S.sort.dir > 0 ? 'ascending' : 'descending');
    else b.removeAttribute('aria-sort');
  });

  const mk = S.manifest.markets[S.market] || {};
  const shown = all.length > rows.length
    ? `showing ${rows.length} of ${all.length} matches — search to narrow`
    : `${all.length} of ${mk.count} funds`;
  document.getElementById('listFoot').innerHTML = mk
    ? `${shown} · quoted in ${mk.currency} (${mk.symbol}) · ${mk.venue}`
    : '';
}

/* ------------------------------------------------------------- controls */
/* TEFAS publishes one NAV per day: no open/high/low and no volume. At the
   daily step a candle would be a flat doji, so only line and area are
   offered there. At coarser steps the open/high/low are a genuine
   aggregation of the daily closes in the bucket, so candles are allowed and
   the note below says what they are built from. */
function isNav(etf) { return etf && etf.priceType === 'nav'; }
function navFlatAtStep() { return isNav(S.etf) && S.tf === '1d'; }

function renderControls() {
  const etf = S.etf;
  const segR = document.getElementById('segRange');
  segR.innerHTML = RANGES.map(r =>
    `<button class="seg" data-r="${r.id}" aria-pressed="${S.range === r.id}">${r.label}</button>`).join('');
  segR.querySelectorAll('.seg').forEach(b => b.onclick = () => {
    S.range = b.dataset.r; renderControls(); recompute();
  });

  const cw = document.getElementById('customWrap');
  cw.hidden = S.range !== 'custom';
  const df = document.getElementById('dFrom'), dt = document.getElementById('dTo');
  df.value = S.custom.from; dt.value = S.custom.to;
  df.onchange = () => { S.custom.from = df.value; recompute(); };
  dt.onchange = () => { S.custom.to = dt.value; recompute(); };

  const segT = document.getElementById('segTf');
  segT.innerHTML = TF.map((t, i) => {
    const have = !!(etf && etf.series[t.base]);
    const div = (i === 2 || i === 5) ? '<span class="seg-div" aria-hidden="true"></span>' : '';
    return `${div}<button class="seg" data-tf="${t.id}" aria-pressed="${S.tf === t.id}"
      ${have ? '' : 'disabled title="base resolution not stored for this fund"'}>${t.label}</button>`;
  }).join('');
  segT.querySelectorAll('.seg').forEach(b => b.onclick = () => {
    S.tf = b.dataset.tf;
    if (navFlatAtStep() && ['candles', 'hollow', 'bars'].includes(S.style)) S.style = 'area';
    renderControls(); recompute();
  });

  const segS = document.getElementById('segStyle');
  const flat = navFlatAtStep();
  const ohlcStyle = new Set(['candles', 'hollow', 'bars']);
  segS.innerHTML = STYLES.map(s => {
    const off = flat && ohlcStyle.has(s.id);
    return `<button class="seg" data-st="${s.id}" aria-pressed="${S.style === s.id}"
      ${off ? 'disabled title="this fund reports one net asset value per day, so a daily bar has no high or low"' : ''}>${s.label}</button>`;
  }).join('');
  segS.querySelectorAll('.seg').forEach(b => b.onclick = () => {
    S.style = b.dataset.st; renderControls(); drawSeries(true);
  });

  const segO = document.getElementById('segOv');
  const ovs = isNav(etf) ? [['sma20', 'SMA 20'], ['sma50', 'SMA 50']]
                         : [['vol', 'Volume'], ['sma20', 'SMA 20'], ['sma50', 'SMA 50']];
  segO.innerHTML = ovs.map(([k, l]) =>
    `<button class="seg" data-ov="${k}" aria-pressed="${S.overlays[k]}">${l}</button>`).join('') +
    `<span class="seg-div" aria-hidden="true"></span><button class="seg" data-fit="1" title="Reset zoom">Fit</button>`;
  segO.querySelectorAll('[data-ov]').forEach(b => b.onclick = () => {
    S.overlays[b.dataset.ov] = !S.overlays[b.dataset.ov]; renderControls(); drawSeries(true);
  });
  segO.querySelector('[data-fit]').onclick = () => CH.chart && CH.chart.timeScale().fitContent();
}

/* ----------------------------------------------------------- stats + header */
function renderInstrument() {
  const e = S.etf;
  const d = decimals(e.stats.last);
  document.getElementById('iTicker').textContent = e.display;
  const mk = document.getElementById('iMkt');
  mk.textContent = e.market === 'US' ? 'United States' : 'Türkiye';
  mk.dataset.m = e.market;
  document.getElementById('iCat').textContent = e.category;
  const th = document.getElementById('iTheme');
  if (th) {
    th.hidden = !e.theme || e.theme === 'Unclassified';
    th.textContent = e.theme || '';
    th.style.borderColor = 'var(--accent)';
    th.style.color = 'var(--accent)';
  }
  // An exchange-traded fund and an open-ended mutual fund behave very
  // differently; the header says which one you are looking at.
  const cls = document.getElementById('iClass');
  if (cls) {
    const mutual = e.fundClass === 'mutual';
    cls.hidden = !e.fundClass;
    cls.textContent = mutual ? 'Mutual fund' : 'Exchange-traded';
    cls.style.borderColor = mutual ? 'var(--line-2)' : 'var(--accent)';
    cls.style.color = mutual ? 'var(--text-3)' : 'var(--accent)';
  }
  document.getElementById('iName').textContent = e.name;
  document.getElementById('iMeta').innerHTML =
    [e.exchange, e.symbol, e.timezone,
     `${e.stats.bars} daily bars from ${e.stats.firstDate}`,
     e.dailySource === '1h' ? 'daily bars aggregated from hourly' : null,
     e.dailySource === 'tefas' ? `TEFAS ${e.tefasCode} · daily net asset value` : null,
     e.riskValue ? `risk ${e.riskValue}/7` : null]
      .filter(Boolean).map(x => `<span>${x}</span>`).join('');

  document.getElementById('qCur').textContent = S.manifest.markets[e.market].symbol;
  document.getElementById('qLast').textContent = nf(e.stats.last, d);
  const ch = e.stats.chgPct, ytd = e.stats.ytdPct;
  document.getElementById('qChg').innerHTML =
    `<span class="${sign(ch)}">${pf(ch)} <span style="color:var(--text-3)">last close</span></span>
     <span class="${sign(ytd)}">${pf(ytd)} <span style="color:var(--text-3)">YTD 26</span></span>`;
  document.getElementById('qSub').textContent =
    `52w ${nf(e.stats.low52, d)} – ${nf(e.stats.high52, d)} · avg vol ${volFmt(e.stats.avgVol)}`;
}

function renderStats(a) {
  const el = document.getElementById('stats');
  if (!a) {
    el.innerHTML = `<div class="stat"><div class="stat-k">No data</div>
      <div class="stat-v">—</div><div class="stat-s">try a wider period</div></div>`;
    return;
  }
  const d = decimals(a.close);
  const withTime = INTRADAY.has(S.tf);
  const cells = [
    ['Period open', nf(a.open, d), fmtLocal(a.from, withTime)],
    ['Period close', nf(a.close, d), fmtLocal(a.to, withTime)],
    ['Period high', nf(a.high, d), fmtLocal(a.hiAt, withTime)],
    ['Period low', nf(a.low, d), fmtLocal(a.loAt, withTime)],
    ['Return', pf(a.ret), `over ${a.bars} × ${TF_BY_ID[S.tf].label}`, sign(a.ret)],
    ['Max drawdown', pf(a.mdd), 'close to close', a.mdd < 0 ? 'down' : 'flat'],
    ['Volatility', a.sigma == null ? '—' : a.sigma.toFixed(1) + '%', 'annualised'],
    ['Volume', volFmt(a.vol), `avg ${volFmt(a.avgVol)} / bar`],
    ['Bars', String(a.bars), TF_BY_ID[S.tf].mode === 'none' ? 'as retrieved' : `resampled from ${TF_BY_ID[S.tf].base}`],
  ];
  el.innerHTML = cells.map(([k, v, s, cls]) =>
    `<div class="stat"><div class="stat-k">${k}</div>
      <div class="stat-v ${cls || ''}">${v}</div><div class="stat-s">${s}</div></div>`).join('');
}

function renderExport(a) {
  const r = RANGES.find(x => x.id === S.range);
  const cells = [
    ['Instrument', `${S.etf.display} · ${S.etf.market}`],
    ['Period', r.custom ? `${S.custom.from} → ${S.custom.to}` : r.label],
    ['Time step', TF_BY_ID[S.tf].label],
    ['Rows', a ? String(a.bars) : '0'],
    ['Sheets', 'Prices + Summary'],
  ];
  document.getElementById('exGrid').innerHTML = cells.map(([k, v]) =>
    `<div class="ex-cell"><div class="ex-k">${k}</div><div class="ex-v">${v}</div></div>`).join('');
  const dis = !a;
  document.getElementById('btnXlsx').disabled = dis;
  document.getElementById('btnCsv').disabled = dis;
}

/* Explain, rather than silently truncate, when the stored base resolution
   does not reach as far back as the chosen period. */
function renderNote(from) {
  const el = document.getElementById('chartNote');
  const tf = TF_BY_ID[S.tf];
  const base = S.etf.series[tf.base];
  if (!base) {
    el.hidden = false;
    el.textContent = `No ${tf.base} data stored for ${S.etf.display}. Re-run the retriever with --intervals ${tf.base}.`;
    return;
  }
  // A reporting break makes every return through it meaningless; say so
  // before anyone reads a number off this chart.
  const brk = (S.etf.stats || {}).priceBreak;
  if (brk) {
    el.hidden = false;
    el.textContent =
      (brk.kind === 'collapse'
        ? `${S.etf.display}'s published net asset value has fallen to ${(brk.ratio * 100).toFixed(3)}% of its peak, which an open-ended fund does not do — it would be wound up first. This is a reporting problem at the source, not performance. The fund is left out of its theme's averages and its returns should not be used.`
        : `${S.etf.display}'s published price steps by ${brk.ratio < 1
        ? '÷' + Math.round(1 / brk.ratio).toLocaleString()
        : '×' + Math.round(brk.ratio).toLocaleString()} on ${brk.date}. ` +
      `Dozens of funds break on the same date, so this is a change at the source, not a price move. ` +
      `It is reported rather than corrected, and this fund is left out of its theme's averages — ` +
      `treat returns spanning ${brk.date} as unusable.`);
    return;
  }
  if (isNav(S.etf) && TF_BY_ID[S.tf].mode !== 'none') {
    el.hidden = false;
    el.textContent = `${S.etf.display} reports one net asset value per day, so each ${tf.label} bar's open, high and low are taken from the daily closes inside it, not from intraday trading.`;
    return;
  }
  const covers = base.t[0];
  if (from != null && covers > from + 86400) {
    const gmt = S.etf.gmtoffset || 0;
    el.hidden = false;
    el.textContent =
      `Stored history for ${S.etf.display} begins ${fmtLocal(covers + gmt, false)}, so the chart starts there rather than at the period start.`;
    return;
  }
  el.hidden = true;
}

/* ------------------------------------------------------------------ driver */
function recompute() {
  if (!S.etf) return;
  const [from, to] = rangeBounds();
  S.bars = buildBars(S.etf, S.tf, from, to);
  const a = analytics(S.bars);
  renderNote(from);
  renderStats(a);
  renderExport(a);
  drawSeries(false);
  const m = document.getElementById('exMsg');
  if (m) { m.textContent = ''; m.dataset.s = ''; }
}

function fileFor(market, symbol) {
  const row = (S.rows[market] || []).find(e => e.s === symbol);
  const display = row ? row.d : symbol.replace('.TEFAS', '');
  return `${market.toLowerCase()}/${display}.json`;
}

async function loadEtf(symbol) {
  if (S.cache.has(symbol)) return S.cache.get(symbol);
  const file = fileFor(S.market, symbol);
  const res = await fetch(DATA + file, { cache: 'default' });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const rec = await res.json();
  S.cache.set(symbol, rec);
  return rec;
}

async function select(symbol) {
  if (S.loading) return;
  S.loading = true;
  S.symbol = symbol;
  renderList();
  try {
    S.etf = await loadEtf(symbol);
    if (!S.etf.series[TF_BY_ID[S.tf].base]) S.tf = '1d';
    if (navFlatAtStep() && ['candles', 'hollow', 'bars'].includes(S.style)) S.style = 'area';
    renderInstrument();
    renderControls();
    recompute();
  } catch (err) {
    document.getElementById('ws').innerHTML =
      `<div class="boot"><h1>Could not load ${symbol}</h1><p><code>${err.message}</code></p></div>`;
  } finally {
    S.loading = false;
  }
}

/* -------------------------------------------------------------------- theme */
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function initTheme() {
  document.getElementById('themeBtn').onclick = () => {
    document.documentElement.dataset.theme = currentTheme() === 'dark' ? 'light' : 'dark';
    requestAnimationFrame(applyChartTheme);
  };
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) requestAnimationFrame(applyChartTheme);
  });
}

/* --------------------------------------------------------------------- boot */
async function boot() {
  const root = document.getElementById('root');
  let manifest;
  try {
    const res = await fetch(DATA + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    root.innerHTML = `<div class="boot"><h1>Market data not found</h1>
      <p>Could not read <code>data/manifest.json</code> (${err.message}). Run the retriever first:<br>
      <code>python3 retriever/fetch_etfs.py</code></p></div>`;
    return;
  }
  if (!manifest.markets || !Object.keys(manifest.markets).length) {
    root.innerHTML = `<div class="boot"><h1>No funds in the manifest</h1>
      <p>The retriever produced an empty universe. Re-run <code>retriever/fetch_etfs.py</code>.</p></div>`;
    return;
  }

  S.manifest = manifest;
  SPARK_ALPHA = manifest.sparkAlphabet || '';
  if (!manifest.markets[S.market]) S.market = Object.keys(manifest.markets)[0];

  root.innerHTML = shellHTML();
  document.getElementById('ws').innerHTML = wsHTML();
  document.getElementById('asof').textContent =
    new Date(manifest.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  renderClocks();
  setInterval(renderClocks, 1000);
  initTheme();
  renderTabs();
  renderCats();

  document.getElementById('search').oninput = e => { S.filter = e.target.value; renderList(); };
  document.getElementById('catSel').onchange = e => {
    const v = e.target.value;
    S.category = v.startsWith('c:') ? v.slice(2) : '';
    S.theme = v.startsWith('t:') ? v.slice(2) : '';
    if (S.theme) ensureThemes().then(() => { renderThemeBar(); });
    else renderThemeBar();
    renderList();
  };
  document.querySelectorAll('.lhead [data-sort]').forEach(b => b.onclick = () => {
    const k = b.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'display' ? 1 : -1) };
    renderList();
  });
  document.getElementById('btnXlsx').onclick = () => doExport('xlsx');
  document.getElementById('btnCsv').onclick = () => doExport('csv');

  buildChart();
  try {
    await ensureRows(S.market);
  } catch (err) {
    document.getElementById('list').innerHTML =
      `<div style="padding:22px 12px;color:var(--down);font-size:12px">${err.message}</div>`;
    return;
  }
  renderList();
  const opening = openingFund(S.market);
  if (opening) await select(opening.s);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
