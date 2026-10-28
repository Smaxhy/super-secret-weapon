/**
 * v28 (owner: "better and faster instead of TradingView"): a canvas candle chart on TradingView's open-source
 * Lightweight Charts (Apache-2.0, ~45 KB, no account, no outside data) fed by the bot's OWN candles and live ticks — so
 * it shows the prices the bot trades on, ticks with the live push, scrolls / zooms with a finger or the wheel and draws
 * the bot's entry / stop / target / lock as price lines and its trades as markers. Replaces the TradingView embed
 * (a third-party iframe on different, often late, prices). Also the replay player's chart (FxReplay.tsx).
 * Times are shown in the viewer's clock (each candle's time is shifted by its own UTC offset).
 */
import { useEffect, useRef } from 'react';
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, createSeriesMarkers, type CandlestickData, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';

export interface FastLine { price: number; color: string; title?: string; style?: 'solid' | 'dashed' | 'dotted'; width?: 1 | 2 }
export interface FastMarker { t: number; kind: 'buy' | 'sell' | 'exit'; text?: string; color?: string }

/** ms → the chart's time: seconds, moved onto the viewer's clock. Pure. */
export function chartTime(ms: number): UTCTimestamp {
  return (Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60) as UTCTimestamp;
}

/** [t,o,h,l,c] rows (ms) → candles; broken rows dropped, sorted, one per time. Pure. */
export function toCandles(bars: ReadonlyArray<ReadonlyArray<number>>): Array<CandlestickData<UTCTimestamp>> {
  const out: Array<CandlestickData<UTCTimestamp>> = [];
  const rows = [...bars].filter((b) => b.length >= 5 && b.slice(0, 5).every(Number.isFinite) && b[4]! > 0).sort((a, b) => a[0]! - b[0]!);
  for (const b of rows) {
    const time = chartTime(b[0]!);
    const [o, h, l, c] = [b[1]!, b[2]!, b[3]!, b[4]!];
    const c0 = { time, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c };
    if (out.length && out[out.length - 1]!.time >= time) out[out.length - 1] = c0;
    else out.push(c0);
  }
  return out;
}

/** The candle a time falls in (the newest candle opened at or before it), or null. Pure. */
export function snapTime(candles: ReadonlyArray<{ time: UTCTimestamp }>, ms: number): UTCTimestamp | null {
  const t = chartTime(ms);
  let lo = 0;
  let hi = candles.length - 1;
  let best: UTCTimestamp | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time <= t) {
      best = candles[mid]!.time;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

const css = (name: string, fallback: string) => {
  const v = typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '';
  return v || fallback;
};
/** the viewer's locale when the browser accepts it (some report tags like "en-US@posix" that Intl rejects) */
function safeLocale(): string {
  const want = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  try {
    new Intl.DateTimeFormat(want);
    return want;
  } catch {
    return 'en-US';
  }
}
const STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;

function themeOptions() {
  const ink = css('--muted', '#65707d');
  const grid = css('--border', 'rgba(127,127,127,0.15)');
  return {
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: ink, fontSize: 11 },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: grid },
    timeScale: { borderColor: grid },
  };
}
function candleColors() {
  const up = css('--up-text', '#137f41');
  const down = css('--down-text', '#c42f2f');
  return { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderUpColor: up, borderDownColor: down };
}

export function FastChart({
  bars,
  digits,
  height = 380,
  lines = [],
  markers = [],
  visible = 120,
  fitKey = '',
  className = '',
  label = 'Price chart',
}: {
  /** [t,o,h,l,c] rows in ms */
  bars: ReadonlyArray<ReadonlyArray<number>>;
  digits: number;
  height?: number;
  lines?: FastLine[];
  markers?: FastMarker[];
  /** candles in view when the data (re)loads */
  visible?: number;
  /** changes → the view jumps back to the newest `visible` candles (new market / candle size) */
  fitKey?: string;
  className?: string;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const marks = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const shown = useRef<{ key: string; n: number; first: number; last: number }>({ key: '\u0000', n: 0, first: 0, last: 0 });
  const candlesRef = useRef<Array<CandlestickData<UTCTimestamp>>>([]);
  /** prices the view must keep in sight (the trade's stop / target sit outside the candles) */
  const keep = useRef<number[]>([]);

  // one chart for the component's life; theme follows light / dark
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = createChart(el, {
      autoSize: true,
      ...themeOptions(),
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: safeLocale() },
      timeScale: { ...themeOptions().timeScale, timeVisible: true, secondsVisible: false, rightOffset: 4, shiftVisibleRangeOnNewBar: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    const s = c.addSeries(CandlestickSeries, {
      ...candleColors(),
      priceLineVisible: true,
      lastValueVisible: true,
      autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const r = orig();
        if (!r?.priceRange || !keep.current.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...keep.current), maxValue: Math.max(r.priceRange.maxValue, ...keep.current) } };
      },
    });
    chart.current = c;
    series.current = s;
    marks.current = createSeriesMarkers(s, []);
    const retheme = () => {
      c.applyOptions(themeOptions());
      s.applyOptions(candleColors());
    };
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-ws'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', retheme);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', retheme);
      c.remove();
      chart.current = null;
      series.current = null;
      marks.current = null;
      priceLines.current = [];
      shown.current = { key: '\u0000', n: 0, first: 0, last: 0 };
    };
  }, []);

  useEffect(() => {
    series.current?.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 1 / 10 ** digits } });
  }, [digits]);

  // candles: a tick or one new candle → update() (cheap); anything else → setData() and the view resets
  useEffect(() => {
    const s = series.current;
    const c = chart.current;
    if (!s || !c) return;
    const cs = toCandles(bars);
    candlesRef.current = cs;
    const prev = shown.current;
    const first = cs[0]?.time ?? 0;
    const last = cs[cs.length - 1]?.time ?? 0;
    const sameRun = prev.key === fitKey && prev.n > 0 && cs.length >= prev.n && cs.length <= prev.n + 3 && first === prev.first && last >= prev.last;
    if (sameRun) {
      for (let i = Math.max(0, prev.n - 1); i < cs.length; i++) s.update(cs[i]!);
    } else {
      s.setData(cs);
      if (cs.length) {
        const n = Math.min(cs.length, visible);
        c.timeScale().setVisibleLogicalRange({ from: cs.length - n - 0.5, to: cs.length + 3 });
      }
    }
    shown.current = { key: fitKey, n: cs.length, first, last };
  }, [bars, fitKey, visible]);

  // price lines (entry / stop / target / lock …)
  const linesKey = JSON.stringify(lines);
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of priceLines.current) s.removePriceLine(l);
    keep.current = lines.filter((l) => Number.isFinite(l.price) && l.price > 0).map((l) => l.price);
    priceLines.current = lines
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .map((l) => s.createPriceLine({ price: l.price, color: l.color, lineWidth: l.width ?? 1, lineStyle: STYLE[l.style ?? 'dashed'], axisLabelVisible: true, title: l.title ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  // markers (snapped onto the candle they happened in)
  const marksKey = JSON.stringify(markers);
  useEffect(() => {
    const m = marks.current;
    if (!m) return;
    const cs = candlesRef.current;
    const out: Array<SeriesMarker<Time>> = [];
    for (const k of markers) {
      const time = snapTime(cs, k.t);
      if (time === null) continue;
      const up = css('--up-text', '#137f41');
      const down = css('--down-text', '#c42f2f');
      out.push(
        k.kind === 'buy'
          ? { time, position: 'belowBar', shape: 'arrowUp', color: k.color ?? up, text: k.text ?? '' }
          : k.kind === 'sell'
            ? { time, position: 'aboveBar', shape: 'arrowDown', color: k.color ?? down, text: k.text ?? '' }
            : { time, position: 'inBar', shape: 'circle', color: k.color ?? css('--muted', '#65707d'), text: k.text ?? '' },
      );
    }
    out.sort((a, b) => (a.time as number) - (b.time as number));
    m.setMarkers(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, bars]);

  return <div ref={box} role="img" aria-label={label} className={`w-full ${className}`} style={{ height }} />;
}
