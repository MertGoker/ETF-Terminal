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
  page: 'etfs',
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
    <nav class="nav" id="nav" aria-label="Sections"></nav>
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

  <main>
  <section class="page" id="page-home" hidden></section>
  <section class="page" id="page-portfolio" hidden></section>
  <section class="page" id="page-system" hidden></section>

  <section class="page" id="page-etfs">
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
  </footer>
  </section>
  </main>`;
}

const PAGES = [
  { id: 'home', label: 'Home' },
  { id: 'etfs', label: 'ETFs' },
  { id: 'portfolio', label: 'My Portfolio' },
  { id: 'system', label: 'System' },
];

function renderNav() {
  const el = document.getElementById('nav');
  el.innerHTML = PAGES.map(p => {
    const on = S.page === p.id;
    const badge = p.id === 'etfs' && S.manifest
      ? `<span class="nav-badge">${Object.values(S.manifest.markets)
            .reduce((a, m) => a + (m.count || 0), 0).toLocaleString('en-US')}</span>`
      : '';
    return `<button class="nav-btn" data-page="${p.id}"
      ${on ? 'aria-current="page"' : ''}>${p.label}${badge}</button>`;
  }).join('');
  el.querySelectorAll('[data-page]').forEach(b =>
    b.onclick = () => setPage(b.dataset.page));
}

/* Pages stay in the DOM and are toggled, not rebuilt: the chart is
   expensive to construct and the ETF page holds scroll position, selection
   and a loaded fund that should survive a trip to System and back. */
function setPage(id) {
  if (!PAGES.some(p => p.id === id)) id = 'etfs';
  S.page = id;
  for (const p of PAGES) {
    const el = document.getElementById('page-' + p.id);
    if (el) el.hidden = p.id !== id;
  }
  renderNav();
  try { localStorage.setItem('bourse.page', id); } catch (_) {}
  if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);

  // A chart laid out while its container was hidden has zero width.
  if (id === 'etfs') fitSoon();
  if (id === 'system') systemEnter(); else systemLeave();
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
  document.getElementById('page-home').innerHTML = homePageHTML();
  document.getElementById('page-portfolio').innerHTML = portfolioPageHTML();
  document.getElementById('page-system').innerHTML = systemPageHTML();
  document.getElementById('asof').textContent =
    new Date(manifest.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  renderClocks();
  setInterval(renderClocks, 1000);
  initTheme();

  const wanted = location.hash.slice(1) || lsGet('bourse.page', 'etfs');
  setPage(PAGES.some(p => p.id === wanted) ? wanted : 'etfs');
  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && id !== S.page) setPage(id);
  });

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
  renderNav();
  renderList();
  const opening = openingFund(S.market);
  if (opening) await select(opening.s);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* =====================================================================
   Pages beyond the ETF workspace.

   The workspace above is a trading screen: dense, dark, scanned for price
   action. These pages are read and operated instead, so they use IBM Plex
   and a lot more air. Home and My Portfolio are deliberately unbuilt —
   they announce themselves as such rather than faking a dashboard.
   ===================================================================== */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);
const isLocalHost = h => LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || h.endsWith('.test');

function lsGet(k, fallback = '') {
  try { return localStorage.getItem(k) ?? fallback; } catch (_) { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch (_) {}
}

/* Two control planes answer the same client code. Locally it is the FastAPI
   service, which can read the data directory and run the retriever itself.
   On the deployed site it is the Vercel functions in `api/`, which dispatch a
   GitHub Actions run instead — a serverless function cannot do the work, but
   it can hold the token that starts something that can. */
function defaultApiBase() {
  const local = isLocalHost(location.hostname) || location.protocol === 'file:';
  const stored = lsGet('bourse.apiBase', '');
  // A base saved while developing must not follow you to production.
  if (stored && (local || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(stored))) {
    return stored;
  }
  return local ? 'http://127.0.0.1:8000' : location.origin;
}

const SYS = {
  api: { base: defaultApiBase(), mode: null, state: 'idle', ping: null, health: null, ms: null },
  deploy: { url: lsGet('bourse.publicUrl', ''), state: 'idle', ms: null, detail: '' },
  runtime: { state: 'idle', checks: [], ms: null },
  sync: { state: null, job: null, poll: null, busy: false },
  upstream: null,
  lastRun: null,
  entered: false,
};

/* ------------------------------------------------------------- placeholders */
function placeholderHTML(kicker, title, lede, mark, planned) {
  return `<div class="plain">
    <div class="page-head">
      <div class="page-kicker">${kicker}</div>
      <h1 class="page-title">${title}</h1>
      <p class="page-lede">${lede}</p>
    </div>
    <div class="placeholder">
      <div class="placeholder-mark">${mark}</div>
      <h2>Not built yet</h2>
      <p>This section is reserved. Nothing here is live, and nothing on it is
         wired to your data — the ETFs and System pages are the working parts
         of the terminal today.</p>
      <div class="planned">${planned.map(x => `<span>${x}</span>`).join('')}</div>
    </div>
  </div>`;
}

const ICON_HOME = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/></svg>`;
const ICON_PORT = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M3 12h18"/></svg>`;

function homePageHTML() {
  return placeholderHTML(
    'Overview', 'Home',
    'A standing view of both markets — breadth, movers and the state of the data behind them.',
    ICON_HOME,
    ['Market breadth', 'Top movers', 'Theme performance', 'Data freshness']);
}

function portfolioPageHTML() {
  return placeholderHTML(
    'Positions', 'My Portfolio',
    'Your own holdings valued against the same price history the terminal charts.',
    ICON_PORT,
    ['Holdings', 'Cost basis', 'Allocation', 'Return vs benchmark']);
}

/* ----------------------------------------------------------------- system */
function bannerHTML(n, id, title, sub, pillId, readId, subId, body) {
  return `<div class="bn" data-bn="${id}" data-open="0">
    <button class="bn-head" aria-expanded="false" data-toggle="${id}">
      <span class="bn-n">${n}</span>
      <span class="bn-id"><b>${title}</b><small>${sub}</small></span>
      <span class="bn-read"><b id="${readId}">—</b><span id="${subId}">not checked</span></span>
      <span class="pill" data-s="idle" id="${pillId}">Idle</span>
      <span class="bn-caret" aria-hidden="true">›</span>
    </button>
    <div class="bn-body" hidden>${body}</div>
  </div>`;
}

function systemPageHTML() {
  return `<div class="plain">
    <div class="page-head">
      <div class="page-kicker">Operations</div>
      <h1 class="page-title">System</h1>
      <p class="page-lede">Health of the dashboard, its public deployment and the control
         plane behind it — plus the one action that changes anything: bringing stored
         prices up to today.</p>
    </div>

    <div class="banners">
      ${bannerHTML('01', 'runtime', 'Dashboard runtime', 'The page you are looking at',
        'pillRuntime', 'rtScore', 'rtSummary',
        `<div class="checks" id="rtChecks"></div>`)}

      ${bannerHTML('02', 'deploy', 'Public deployment', 'Is the terminal live on the web',
        'pillDeploy', 'dpState', 'dpSummary',
        `<dl class="kv" id="dpMeta"></dl>
         <div class="field">
           <input id="dpUrl" type="url" spellcheck="false" placeholder="https://your-site.vercel.app">
           <button class="action" id="btnDeploySave">Save</button>
         </div>
         <p class="hint" id="dpHint"></p>`)}

      ${bannerHTML('03', 'api', 'Control plane', 'FastAPI health and sync service',
        'pillApi', 'apiState', 'apiSummary',
        `<dl class="kv" id="apiMeta"></dl>
         <div class="checks" id="apiChecks"></div>
         <div class="field">
           <input id="apiUrl" type="url" spellcheck="false" placeholder="http://127.0.0.1:8000">
           <button class="action" id="btnApiSave">Save</button>
         </div>
         <p class="hint" id="apiHint"></p>`)}

      ${bannerHTML('04', 'sync', 'Data synchronization', 'Newest stored bar → today',
        'pillSync', 'syncState', 'syncSummary',
        `<div class="src" id="syncUpstream"></div>
         <p class="hint" id="syncHint">Daily bars are the stored resolution; every coarser
            step — 3D through 1Y — is resampled from them in the browser, so one daily
            sync refreshes every step the terminal offers.</p>`)}
    </div>

    <div class="ops">
      <div class="ops-item">
        <div class="ops-k">All subsystems</div>
        <div class="ops-v" id="sysStamp">not checked</div>
        <button class="action action-primary" id="btnHealth">Run health check</button>
      </div>
      <div class="ops-item">
        <div class="ops-k">Latest data on record</div>
        <div class="ops-v" id="syncStamp">—</div>
        <button class="action action-primary" id="btnSync" disabled>Synchronize now</button>
      </div>
    </div>

    <div class="ops-extra">
      <div class="bar" id="syncBar" hidden><i style="width:0"></i></div>
      <div class="stall" id="syncStall" hidden></div>
      <div class="diag" id="syncDiag"></div>
      <div class="console" id="syncLog"></div>
    </div>
  </div>`;
}

function wireBanners() {
  document.querySelectorAll('#page-system [data-toggle]').forEach(btn => {
    btn.onclick = () => {
      const wrap = btn.closest('.bn');
      const open = wrap.dataset.open === '1';
      wrap.dataset.open = open ? '0' : '1';
      btn.setAttribute('aria-expanded', String(!open));
      wrap.querySelector('.bn-body').hidden = open;
    };
  });
}

/* The dispatch plane has no deep health check and no upstream probe: it runs
   nowhere near the data or the feeds. Routes it does not serve are null, and
   the probes below branch on that rather than guessing. */
function routes() {
  const base = SYS.api.base.replace(/\/+$/, '');
  const gha = SYS.api.mode === 'github-actions';
  return {
    gha,
    ping: base + '/api/ping',
    health: gha ? null : base + '/api/health',
    upstream: gha ? null : base + '/api/upstream',
    state: base + (gha ? '/api/sync-state' : '/api/sync/state'),
    start: base + '/api/sync',
    job: id => base + (gha ? `/api/sync-status?id=${encodeURIComponent(id)}`
                           : `/api/sync/${id}`),
  };
}

/* ------------------------------------------------------------------ probes */
async function fetchJSON(url, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    const ms_ = Math.round(performance.now() - t0);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { ms: ms_ });
    return { data: await res.json(), ms: ms_ };
  } finally {
    clearTimeout(timer);
  }
}

function setPill(id, state, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.s = state;
  el.textContent = text;
}

function checkRow(c) {
  const glyph = { pass: '✓', warn: '!', error: '✕', run: '•' }[c.status] || '•';
  return `<div class="check" data-s="${c.status}">
    <i>${glyph}</i><span><b>${c.name}</b></span><em>${c.detail}</em></div>`;
}

/* 01 — the page itself. "Open" is not a health check on its own, so this
   probes the things that are actually load-bearing for the dashboard. */
async function probeRuntime() {
  setPill('pillRuntime', 'busy', 'Checking');
  const checks = [];
  const t0 = performance.now();

  checks.push({ name: 'Script runtime', status: 'pass', detail: 'executing' });
  checks.push({
    name: 'Manifest', status: S.manifest ? 'pass' : 'error',
    detail: S.manifest ? `${Object.values(S.manifest.markets).reduce((a, m) => a + (m.count || 0), 0).toLocaleString('en-US')} funds` : 'not loaded',
  });
  checks.push({
    name: 'Chart engine', status: window.LightweightCharts ? 'pass' : 'error',
    detail: window.LightweightCharts ? 'lightweight-charts ready' : 'library blocked',
  });

  let dataMs = null, dataOk = false;
  try {
    const r = await fetchJSON(DATA + 'manifest.json', 5000);
    dataMs = r.ms; dataOk = true;
  } catch (err) { dataMs = err.ms ?? null; }
  checks.push({
    name: 'Market data', status: dataOk ? 'pass' : 'error',
    detail: dataOk ? `data/ reachable · ${dataMs} ms` : 'data/ unreachable',
  });

  // Row tables are fetched the first time a market is shown. Not having
  // them yet is the design, not a fault, so this reports state rather than
  // marking the runtime degraded for working as intended.
  const loaded = Object.keys(S.rows || {}).length;
  checks.push({
    name: 'Fund rows', status: 'pass',
    detail: loaded ? `${loaded} market(s) cached` : 'lazy — loaded on first view',
  });

  let storage = false;
  try { localStorage.setItem('bourse.probe', '1'); localStorage.removeItem('bourse.probe'); storage = true; } catch (_) {}
  checks.push({
    name: 'Browser storage', status: storage ? 'pass' : 'warn',
    detail: storage ? 'writable' : 'blocked (private mode)',
  });

  const bad = checks.filter(c => c.status === 'error').length;
  const warn = checks.filter(c => c.status === 'warn').length;
  const state = bad ? 'error' : warn ? 'warn' : 'pass';
  SYS.runtime = { state, checks, ms: Math.round(performance.now() - t0) };

  setPill('pillRuntime', state, state === 'pass' ? 'Operational' : state === 'warn' ? 'Degraded' : 'Failing');
  setBanner('rtScore', 'rtSummary', `${checks.length - bad - warn}/${checks.length}`,
    `checks passed · ${SYS.runtime.ms} ms`);
  document.getElementById('rtChecks').innerHTML = checks.map(checkRow).join('');
  return state;
}

/* 02 — served from a public origin, or reachable at the configured one. */
async function probeDeploy() {
  setPill('pillDeploy', 'busy', 'Checking');
  const host = location.hostname;
  const local = isLocalHost(host) || location.protocol === 'file:';
  const meta = [];
  let state, big, summary, hint = '';

  if (!local) {
    state = 'pass';
    big = 'Live';
    summary = `served from ${host}`;
    meta.push(['Origin', location.origin]);
    meta.push(['Protocol', location.protocol.replace(':', '')]);
    meta.push(['Secure context', window.isSecureContext ? 'yes' : 'no']);
    SYS.deploy = { ...SYS.deploy, state, ms: null, detail: host };
  } else if (!SYS.deploy.url) {
    state = 'warn';
    big = 'Local';
    summary = 'public URL not set';
    meta.push(['Origin', location.origin || 'file://']);
    hint = 'Running locally. Enter the deployed URL to probe whether the published site is up.';
    SYS.deploy = { ...SYS.deploy, state, ms: null, detail: 'local only' };
  } else {
    // A cross-origin opaque request cannot be read, but it still fails
    // loudly when the host is unreachable — enough to answer "is it up".
    const t0 = performance.now();
    try {
      await fetch(SYS.deploy.url, { mode: 'no-cors', cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      state = 'pass'; big = 'Live';
      summary = `reachable · ${ms} ms`;
      meta.push(['Deployed URL', SYS.deploy.url]);
      meta.push(['Probe', 'opaque GET (no-cors)']);
      meta.push(['Local origin', location.origin || 'file://']);
      SYS.deploy = { ...SYS.deploy, state, ms, detail: 'reachable' };
    } catch (err) {
      state = 'error'; big = 'Down';
      summary = 'unreachable from this browser';
      meta.push(['Deployed URL', SYS.deploy.url]);
      meta.push(['Error', String(err.message || err).slice(0, 48)]);
      hint = 'The published site did not answer. Check the deployment, or the URL above.';
      SYS.deploy = { ...SYS.deploy, state, ms: null, detail: 'unreachable' };
    }
  }

  setPill('pillDeploy', state, state === 'pass' ? 'Online' : state === 'warn' ? 'Local only' : 'Offline');
  setBanner('dpState', 'dpSummary', big, summary);
  document.getElementById('dpMeta').innerHTML =
    meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  document.getElementById('dpHint').textContent = hint;
  return state;
}

/* 03 — the FastAPI control plane. Absent is a normal state, not a fault:
   the dashboard is static and works without it. */
async function probeApi() {
  setPill('pillApi', 'busy', 'Checking');
  const base = SYS.api.base.replace(/\/+$/, '');
  const meta = [], mixed = location.protocol === 'https:' && base.startsWith('http://');
  let state, big, summary, hint = '', checks = [];

  try {
    const ping = await fetchJSON(base + '/api/ping', 4000);
    SYS.api.ping = ping.data; SYS.api.ms = ping.ms;
    SYS.api.mode = ping.data.mode || 'local';
    meta.push(['Endpoint', base || location.origin]);
    meta.push(['Mode', SYS.api.mode === 'github-actions' ? 'dispatch → GitHub Actions' : 'local service']);
    meta.push(['Latency', ping.ms + ' ms']);

    if (SYS.api.mode === 'github-actions') {
      // Nothing deeper to ask: this plane holds a token and forwards one call.
      meta.push(['Repository', ping.data.repo || 'not resolved']);
      meta.push(['Workflow', `${ping.data.workflow || 'sync.yml'} @ ${ping.data.ref || 'main'}`]);
      state = ping.data.configured ? 'pass' : 'warn';
      big = ping.data.configured ? 'Dispatch' : 'Unconfigured';
      summary = ping.data.detail || 'ready to dispatch';
      if (!ping.data.configured) hint = ping.data.detail || '';
      SYS.api.state = state;
      setPill('pillApi', state, state === 'pass' ? 'Dispatch ready' : 'Needs a token');
      setBanner('apiState', 'apiSummary', big, summary);
      document.getElementById('apiMeta').innerHTML =
        meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      document.getElementById('apiChecks').innerHTML = '';
      document.getElementById('apiHint').textContent = hint;
      return state;
    }

    meta.push(['Version', ping.data.version || '—']);
    meta.push(['Uptime', fmtUptime(ping.data.uptimeSeconds)]);

    try {
      const h = await fetchJSON(routes().health, 15000);
      SYS.api.health = h.data;
      checks = h.data.checks || [];
      state = h.data.status === 'pass' ? 'pass' : h.data.status === 'warn' ? 'warn' : 'error';
      big = state === 'pass' ? 'Healthy' : state === 'warn' ? 'Degraded' : 'Failing';
      const n = checks.length, bad = checks.filter(c => c.status !== 'pass').length;
      summary = `${n - bad}/${n} backend checks passed · ${h.ms} ms`;
      meta.push(['Python', (h.data.runtime || {}).python || '—']);
    } catch (err) {
      state = 'warn'; big = 'Partial';
      summary = 'ping ok, deep check failed';
      hint = String(err.message || err);
    }
    SYS.api.state = state;
  } catch (err) {
    SYS.api.state = 'error'; SYS.api.ping = null; SYS.api.health = null;
    state = 'error'; big = 'Offline';
    summary = 'control plane not reachable';
    meta.push(['Endpoint', base]);
    meta.push(['Error', String(err.message || err).slice(0, 48)]);
    hint = mixed
      ? 'This page is on HTTPS and the control plane is on plain HTTP, so the browser blocks the call. Run the dashboard locally to use it, or put the API behind HTTPS.'
      : 'Static mode — the dashboard works without it. Locally: pip install -r control_plane/requirements.txt, then python3 -m uvicorn control_plane.main:app --port 8000. On the deployed site this is served by the Vercel functions in api/.';
  }

  setPill('pillApi', state, state === 'pass' ? 'Connected' : state === 'warn' ? 'Degraded' : 'Offline');
  setBanner('apiState', 'apiSummary', big, summary);
  document.getElementById('apiMeta').innerHTML =
    meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  document.getElementById('apiChecks').innerHTML = checks.map(checkRow).join('');
  document.getElementById('apiHint').textContent = hint;
  return state;
}

function fmtUptime(sec) {
  if (sec == null) return '—';
  const s = Math.floor(sec);
  if (s < 90) return s + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 172800) return (s / 3600).toFixed(1) + ' h';
  return (s / 86400).toFixed(1) + ' d';
}

/* Upstream reachability. The retriever can only be as healthy as the feeds
   it reads, and a throttled source is by far the most common reason a sync
   produces nothing — so it is reported before the button, not after. */
async function probeUpstream() {
  const el = document.getElementById('syncUpstream');
  if (!el) return null;
  const r = routes();
  if (!r.upstream) {
    // The runner reaches the feeds, not this browser; claiming otherwise
    // would be measuring the wrong machine.
    SYS.upstream = null;
    el.innerHTML = `<div class="src-row" data-s="idle"><span class="dot"></span>
      <span><b>Feed reachability</b><small>measured by the Actions runner, not this browser</small></span>
      <em>n/a</em></div>`;
    return null;
  }
  el.innerHTML = `<div class="src-row" data-s="idle"><span class="dot"></span>
    <span><b>Checking data sources…</b></span><em></em></div>`;
  try {
    const { data } = await fetchJSON(r.upstream, 25000);
    SYS.upstream = data;
    el.innerHTML = data.sources.map(r => `
      <div class="src-row" data-s="${r.status}">
        <span class="dot"></span>
        <span><b>${r.label}</b><small>${r.detail}</small></span>
        <em>${r.ms} ms</em>
      </div>`).join('');
    return data;
  } catch (_) {
    SYS.upstream = null;
    el.innerHTML = '';
    return null;
  }
}

function renderDiagnostics(diags) {
  const el = document.getElementById('syncDiag');
  if (!el) return;
  if (!diags || !diags.length) { el.innerHTML = ''; return; }
  el.innerHTML = diags.map(d => {
    const n = [];
    if (d.retries) n.push(`${d.retries} retried`);
    if (d.failures) n.push(`${d.failures} gave up`);
    return `<div class="diag-card" data-s="${d.severity}">
      <div class="diag-top"><b>${d.title}</b>
        <span class="diag-count">${n.join(' · ') || d.code}</span></div>
      <p class="diag-detail">${d.detail || d.code}</p>
      ${d.hint ? `<p class="diag-hint">${d.hint}</p>` : ''}
      ${d.subjects && d.subjects.length
        ? `<div class="diag-subj">${d.subjects.slice(0, 10).map(x => `<span>${x}</span>`).join('')}
           ${d.subjects.length > 10 ? `<span>+${d.subjects.length - 10}</span>` : ''}</div>` : ''}
    </div>`;
  }).join('');
}

/* 04 — synchronisation. The date above the button is the newest bar the
   terminal actually holds; pressing it refreshes everything from the
   manifest's history start through today at the stored daily resolution. */
function ageState(days) { return days <= 4 ? 'ok' : days <= 10 ? 'warn' : 'bad'; }

function setBanner(readId, subId, big, sub) {
  const a = document.getElementById(readId), b = document.getElementById(subId);
  if (a) a.textContent = big;
  if (b) b.textContent = sub;
}

async function refreshSyncState() {
  const stamp = document.getElementById('syncStamp');
  const btn = document.getElementById('btnSync');
  const hintEl = document.getElementById('syncHint');
  if (!stamp) return;

  try {
    const { data } = await fetchJSON(routes().state, 15000);
    SYS.sync.state = data;
    const rows = Object.entries(data.freshness || {});
    stamp.innerHTML = rows.length ? rows.map(([mk, f]) =>
      `<span>${mk} ${f.lastBar}
       <span class="age" data-s="${ageState(f.ageDays)}">${f.ageDays}d</span></span>`).join('')
      : '<span>no stored bars found</span>';
    const oldest = rows.length ? Math.max(...rows.map(([, f]) => f.ageDays)) : null;
    setBanner('syncState', 'syncSummary',
      oldest == null ? '—' : `${oldest}d`,
      oldest == null ? 'no stored bars' : `since the newest stored bar · ${rows.length} markets`);

    if (data.running) {
      watchJob(data.running);
    } else {
      const up = SYS.upstream;
      const blocked = up && up.canSync === false;
      btn.disabled = false;
      const worst = Math.max(...rows.map(([, f]) => f.ageDays), 0);
      // A blocked feed does not disable the button — the retriever backs off
      // and may still get through — but it must not look like a clean run.
      btn.textContent = blocked
        ? 'Synchronize anyway'
        : worst > 0 ? `Synchronize ${data.historyStart} → today` : 'Synchronize now';
      setPill('pillSync',
        blocked ? 'error' : rows.length && worst <= 4 ? 'pass' : rows.length ? 'warn' : 'idle',
        blocked ? 'Upstream blocked'
          : rows.length ? (worst <= 4 ? 'Current' : 'Stale') : 'Unknown');
      if (blocked) {
        const src = (up.sources || []).find(r => r.code === 'rate_limited') || {};
        renderDiagnostics([{
          severity: 'error', title: src.title || 'Upstream is rate-limiting',
          detail: `${src.label || 'Upstream'} — ${src.detail || 'blocked'}`,
          hint: src.hint || '', retries: 0, failures: 0, code: 'rate_limited', subjects: [],
        }]);
      } else {
        renderDiagnostics(null);
      }
    }
    hintEl.textContent = data.note || hintEl.textContent;
  } catch (_) {
    // No control plane: fall back to what the manifest says, and say why
    // the button cannot run.
    const gen = S.manifest && S.manifest.generatedAt;
    const age = gen ? Math.round((Date.now() - Date.parse(gen)) / 86400000) : null;
    stamp.innerHTML = gen
      ? `<span>${gen.slice(0, 10)}
         <span class="age" data-s="${ageState(age)}">${age}d</span></span>`
      : '<span>unknown</span>';
    setBanner('syncState', 'syncSummary', age == null ? '—' : `${age}d`,
      'from the manifest — control plane offline');
    btn.disabled = true;
    btn.textContent = 'Synchronize now';
    setPill('pillSync', 'idle', 'No control plane');
    hintEl.textContent =
      'Synchronisation needs the control plane. Start it with ' +
      'python3 -m uvicorn api.main:app --port 8000, then re-run the health check.';
  }
}

function logLine(line) {
  const cls = / ok |— retriever exited with code 0/.test(line) ? 'ok'
    : /skip|error|failed|! /i.test(line) ? 'bad'
    : line.startsWith('$') ? 'cmd' : '';
  return `<span class="${cls}">${line.replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' }[c]))}</span>`;
}

function renderJob(job) {
  const bar = document.getElementById('syncBar');
  const log = document.getElementById('syncLog');
  const btn = document.getElementById('btnSync');
  if (!bar) return;

  const running = job.state === 'running' || job.state === 'starting';
  bar.hidden = !running && job.state !== 'done' && job.state !== 'failed';
  bar.dataset.indeterminate = running ? '1' : '0';
  bar.querySelector('i').style.width = running ? '' : '100%';

  btn.disabled = running;
  // A throttled source can leave the retriever backing off for minutes with
  // nothing to print, so show elapsed time: a slow run and a hung one look
  // identical without it.
  const elapsed = job.startedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000)) : 0;
  const clock = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`
    : `${elapsed}s`;
  btn.textContent = running
    ? (job.ok == null ? `Synchronizing… ${clock}` : `Synchronizing… ${job.ok} funds · ${clock}`)
    : job.state === 'done' ? `Synchronize again · took ${clock}` : 'Retry synchronization';

  const diags = job.diagnostics || [];
  const blocking = diags.find(d => d.code === 'rate_limited');
  setPill('pillSync',
    running ? (blocking ? 'error' : 'busy') : job.state === 'done' ? 'pass' : 'error',
    running ? (blocking ? 'Throttled' : 'Running')
      : job.state === 'done' ? (diags.length ? 'Synced with warnings' : 'Synced') : 'Failed');
  renderDiagnostics(diags);

  // Backoff can run for minutes with nothing printed; say so rather than
  // leaving a progress bar that looks hung.
  const stall = document.getElementById('syncStall');
  if (running && job.stalledSeconds > 25) {
    stall.hidden = false;
    stall.textContent = blocking
      ? `Backing off — no progress for ${job.stalledSeconds}s while the feed is throttling`
      : `Waiting on the feed — no progress for ${job.stalledSeconds}s`;
  } else {
    stall.hidden = true;
  }

  if (job.log && job.log.length) {
    log.innerHTML = job.log.map(logLine).join('\n');
    log.scrollTop = log.scrollHeight;
  }
  // A dispatched run's real log lives on GitHub; link to it rather than
  // pretending the few status lines above are the whole story.
  const extra = document.querySelector('.ops-extra');
  let link = document.getElementById('runLink');
  if (job.runUrl) {
    if (!link) {
      link = document.createElement('a');
      link.id = 'runLink';
      link.className = 'action';
      link.target = '_blank';
      link.rel = 'noopener';
      extra.insertBefore(link, extra.firstChild);
    }
    link.href = job.runUrl;
    link.textContent = `Open run #${job.runNumber ?? ''} on GitHub →`;
  } else if (link) {
    link.remove();
  }
}

function watchJob(jobId) {
  clearInterval(SYS.sync.poll);
  const r = routes();
  const tick = async () => {
    try {
      const url = r.gha ? r.job(jobId) : `${r.job(jobId)}?tail=80`;
      const { data } = await fetchJSON(url, 10000);
      SYS.sync.job = data;
      renderJob(data);
      if (data.state === 'done' || data.state === 'failed') {
        clearInterval(SYS.sync.poll);
        SYS.sync.poll = null;
        SYS.sync.busy = false;
        if (data.state === 'done') setTimeout(refreshSyncState, 600);
      }
    } catch (err) {
      clearInterval(SYS.sync.poll);
      SYS.sync.poll = null;
      SYS.sync.busy = false;
      setPill('pillSync', 'error', 'Lost contact');
    }
  };
  SYS.sync.poll = setInterval(tick, r.gha ? 6000 : 1500);
  tick();
}

async function startSync() {
  if (SYS.sync.busy) return;
  SYS.sync.busy = true;
  const log = document.getElementById('syncLog');
  setPill('pillSync', 'busy', 'Starting');
  log.innerHTML = logLine('$ requesting sync…');
  try {
    const res = await fetch(routes().start, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markets: ['US', 'TR'] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    watchJob(data.id);
  } catch (err) {
    SYS.sync.busy = false;
    setPill('pillSync', 'error', 'Failed to start');
    log.innerHTML = logLine('! ' + (err.message || err));
    document.getElementById('btnSync').disabled = false;
  }
}

/* ------------------------------------------------------- orchestration */
async function runHealthCheck() {
  const btn = document.getElementById('btnHealth');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  document.getElementById('sysStamp').textContent = 'Probing subsystems…';

  const [rt, dp, api] = await Promise.all([probeRuntime(), probeDeploy(), probeApi()]);
  await probeUpstream();          // before the sync state, which reads it
  await refreshSyncState();

  // The control plane being absent is not a dashboard fault: a static
  // deployment is a supported way to run this, so it never reads red here.
  const weights = { pass: 0, warn: 1, error: 2, idle: 0 };
  const upstream = SYS.upstream ? (SYS.upstream.canSync === false ? 1 : weights[SYS.upstream.status] ?? 0) : 0;
  const worst = Math.max(weights[rt] ?? 0, weights[dp] ?? 0,
                         api === 'error' ? 1 : (weights[api] ?? 0), upstream);
  const overall = worst === 0 ? 'pass' : worst === 1 ? 'warn' : 'error';

  SYS.lastRun = new Date();
  const verdict = overall === 'pass' ? 'All systems normal'
    : overall === 'warn' ? 'Attention' : 'Failing';
  document.getElementById('sysStamp').innerHTML =
    `<span class="age" data-s="${overall === 'pass' ? 'ok' : overall === 'warn' ? 'warn' : 'bad'}">${verdict}</span>` +
    `<span>${SYS.lastRun.toISOString().replace('T', ' ').slice(11, 19)} UTC</span>`;
  btn.disabled = false;
  btn.textContent = 'Run health check';
}

function systemEnter() {
  if (SYS.entered) return;
  SYS.entered = true;

  wireBanners();
  document.getElementById('apiUrl').value = SYS.api.base;
  document.getElementById('dpUrl').value = SYS.deploy.url;

  document.getElementById('btnHealth').onclick = runHealthCheck;
  document.getElementById('btnSync').onclick = startSync;
  document.getElementById('btnApiSave').onclick = () => {
    const v = document.getElementById('apiUrl').value.trim() || 'http://127.0.0.1:8000';
    SYS.api.base = v; lsSet('bourse.apiBase', v);
    probeApi().then(refreshSyncState);
  };
  document.getElementById('btnDeploySave').onclick = () => {
    const v = document.getElementById('dpUrl').value.trim();
    SYS.deploy.url = v; lsSet('bourse.publicUrl', v);
    probeDeploy();
  };

  runHealthCheck();
}

function systemLeave() {
  clearInterval(SYS.sync.poll);
  SYS.sync.poll = null;
}
