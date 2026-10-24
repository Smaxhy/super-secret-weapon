/**
 * The bot's own chart: hourly candles + what it sees (trendlines, support / resistance, yesterday's range, Asian
 * range) + its open paper trades (entry, stop, target). Plain SVG, scales to the card width.
 * v17.8: optional extras for the Auto-bot's active-trade card (all off by default, so other pages look the same):
 * `width` (draw at the real pixel width so text stays readable on a phone), `live` (price line / label at the live
 * price), `entryMarker` (vertical line at the entry candle), `tradeLabels` (entry / stop / target prices in the right
 * gutter, nudged apart), `timeAxis` (times under the candles), `interactive` (crosshair + the candle's prices). With
 * `entryMarker` / `tradeLabels` the entry / stop / target lines stay on the plot even for a trade opened after the
 * newest candle (`tradeAnchor`), faint over the candles before the entry.
 * v17.13 (owner: "graphs are broken, small and messy"): candles sit side by side by INDEX, not by clock time — a
 * weekend / closed market no longer leaves a big empty gap that squeezes the candles into slivers (a faint dashed line
 * marks the break instead); time labels say the weekday when the day changes and never repeat.
 */
import { useId, useState } from 'react';

export interface ChartLine { kind: 'support' | 'resistance'; t1: number; p1: number; t2: number; p2: number; pNow: number; touches: number; broken: boolean }
export interface ChartLevel { kind: 'support' | 'resistance'; price: number; touches: number }
export interface ChartDrawings {
  lines: ChartLine[];
  levels: ChartLevel[];
  prevDay: { h: number; l: number } | null;
  asia: { h: number; l: number } | null;
  /** v27.39 volume profile (POC + 70% value area) and the 50-candle regression channel (±2 SD) */
  profile?: { poc: number; vah: number; val: number; byVolume: boolean } | null;
  channel?: { t1: number; p1: number; t2: number; p2: number; sd: number; r2: number } | null;
  read?: { lrZ: number | null; r2: number | null; cmf: number | null; relVol: number | null; inValue: boolean | null };
}
/** v17.8: `stop` may be null (a trade without a stop: no stop line) */
export interface ChartTrade { side: 1 | -1; entryT: number; entry: number; stop: number | null; target: number | null; strategy: string; /** v17.11: the price that arms the profit lock (until it armed) */ lockAt?: number | null }

const PAD_R = 64;
const AXIS_H = 20;
const ENTRY = '#6366f1';
const STOP = '#ef4444';
const TARGET = '#22c55e';
const LOCK = '#f59e0b';

/** The usual time between candles (median of the newest gaps). Pure. */
export function barStep(bars: number[][]): number {
  const d: number[] = [];
  for (let i = Math.max(1, bars.length - 60); i < bars.length; i++) d.push(bars[i]![0]! - bars[i - 1]![0]!);
  d.sort((a, b) => a - b);
  return d.length ? Math.max(1, d[Math.floor(d.length / 2)]!) : 60_000;
}

/** v17.13: a time → its place on the candle axis. Candles sit side by side, candle i covering [i, i + 1) × `slot` px
 * from its open time to the next candle; a time inside a closed-market gap sits on the border to the next candle; a
 * time after the newest candle carries on at the candle width. Pure. */
export function xOfTime(bars: number[][], t: number, slot: number, step = barStep(bars)): number {
  const n = bars.length;
  if (!n) return 0;
  if (t <= bars[0]![0]!) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid]![0]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const f = (t - bars[lo]![0]!) / step;
  return (lo + (lo === n - 1 ? f : Math.min(1, f))) * slot;
}

/** v17.13: time labels for the axis — the weekday when the day changes (date only on 4h+ candles), equal labels dropped. Pure. */
export function axisLabels(ts: number[], step: number): string[] {
  const day = (t: number) => new Date(t).toDateString();
  const multi = ts.length > 1 && day(ts[0]!) !== day(ts[ts.length - 1]!);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const out: string[] = [];
  ts.forEach((t, k) => {
    let s: string;
    if (step >= 4 * 3_600_000) s = new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    else if (multi && (k === 0 || day(t) !== day(ts[k - 1]!))) s = `${new Date(t).toLocaleDateString(undefined, { weekday: 'short' })} ${hm(t)}`;
    else s = hm(t);
    out.push(out.includes(s) ? '' : s);
  });
  return out;
}

/** v26.3: only well-formed candles, oldest first, one per time — a candle with a missing / NaN price (a forming bar, a
 * feed hiccup) used to turn the whole chart into NaN coordinates and draw nothing or garbage. Pure. */
export function cleanBars(bars: number[][]): number[][] {
  const ok = bars.filter((b) => Array.isArray(b) && b.length >= 5 && b.slice(0, 5).every((v) => typeof v === 'number' && Number.isFinite(v)) && b[2]! >= b[3]! && b[2]! > 0 && b[3]! > 0);
  ok.sort((a, b) => a[0]! - b[0]!);
  const out: number[][] = [];
  for (const b of ok) {
    // a high / low that doesn't contain the open / close is widened to it
    const c = [b[0]!, b[1]!, Math.max(b[1]!, b[2]!, b[4]!), Math.min(b[1]!, b[3]!, b[4]!), b[4]!];
    if (out.length && out[out.length - 1]![0] === c[0]) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

/** v26.3: a trendline's points at each candle (from its first point to the plot's right edge), in candle slots: a line
 * through time bends at a weekend break the same way the candles do. `null` when it starts after the newest candle. Pure. */
export function linePoints(bars: number[][], l: Pick<ChartLine, 't1' | 'p1' | 't2' | 'p2'>, slot: number): Array<[number, number]> | null {
  const n = bars.length;
  if (!n || !(l.t2 !== l.t1)) return null;
  const slope = (l.p2 - l.p1) / (l.t2 - l.t1);
  const at = (t: number) => l.p1 + slope * (t - l.t1);
  const step = barStep(bars);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = bars[i]![0]!;
    // a candle's centre stands for the middle of its hour; the candle holding the line's first point starts it
    if (t < l.t1 && !(i + 1 < n && bars[i + 1]![0]! > l.t1)) continue;
    pts.push([(i + 0.5) * slot, at(Math.max(t + step / 2, l.t1))]);
  }
  if (!pts.length) return null;
  pts.push([n * slot, at(bars[n - 1]![0]! + step)]);
  return pts.length >= 2 ? pts : null;
}

/** v17.13: how many of the newest candles fit `width` px at ≥ `minPx` each (a phone shows fewer, wider candles). Pure. */
export function fitBars(bars: number[][], width: number, minPx = 6): number[][] {
  const n = Math.max(24, Math.floor(Math.max(0, width - PAD_R) / minPx));
  return bars.length > n ? bars.slice(-n) : bars;
}

const clockOf = (t: number, long: boolean) => (long ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

/** v17.8: spread gutter labels apart (min `gap` px), keeping them inside [lo, hi]. Pure. */
export function spreadLabels<T extends { y: number }>(items: T[], gap: number, lo: number, hi: number): Array<T & { ly: number }> {
  const out = items.map((it) => ({ ...it, ly: it.y })).sort((a, b) => a.ly - b.ly);
  for (let i = 0; i < out.length; i++) out[i]!.ly = Math.max(out[i]!.ly, lo, i ? out[i - 1]!.ly + gap : lo);
  for (let i = out.length - 1; i >= 0; i--) out[i]!.ly = Math.min(out[i]!.ly, hi, i < out.length - 1 ? out[i + 1]!.ly - gap : hi);
  return out;
}

/**
 * v17.8: where one trade's own chart starts its solid entry / stop / target lines (`solid`) and draws the entry marker
 * (`marker`). The newest candle sits half a bar left of the plot edge, so a trade opened after it (a fresh trade, a
 * delayed feed: Yahoo metals run ~10 min behind) would get lines of 0 px or drawn backwards; the solid part is always
 * at least `minLen` px long and the marker stays on the plot. `after` = the entry is past the newest candle. Pure.
 */
export function tradeAnchor(xe: number, cw: number, minLen = 24): { solid: number; marker: number; after: boolean } {
  const x = Number.isFinite(xe) ? xe : 0;
  return { solid: Math.min(Math.max(0, cw - minLen), Math.max(0, x)), marker: Math.min(cw - 2, Math.max(0, x)), after: x > cw - 2 };
}

export function MarketChart({
  bars,
  drawings,
  trades = [],
  digits = 5,
  height = 340,
  show = { lines: true, levels: true, ranges: true, trades: true },
  width = 800,
  live = null,
  entryMarker = false,
  tradeLabels = false,
  timeAxis = false,
  interactive = false,
}: {
  bars: number[][];
  drawings?: ChartDrawings | null;
  trades?: ChartTrade[];
  digits?: number;
  height?: number;
  show?: { lines: boolean; levels: boolean; ranges: boolean; trades: boolean; profile?: boolean; channel?: boolean };
  width?: number;
  live?: number | null;
  entryMarker?: boolean;
  tradeLabels?: boolean;
  timeAxis?: boolean;
  interactive?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const clipId = `mc${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  bars = cleanBars(bars);
  if (bars.length < 2) return <div className="grid h-40 place-items-center text-sm text-muted">No candles yet.</div>;
  const W = Math.max(200, width);
  const padR = tradeLabels ? 72 : PAD_R;
  const single = tradeLabels || entryMarker; // v17.8: one trade's own chart (the Auto-bot's active-trade card)
  const H = timeAxis ? height - AXIS_H : height;
  const t0 = bars[0]![0]!;
  const t1 = bars[bars.length - 1]![0]!;
  const step = barStep(bars);
  let lo = Math.min(...bars.map((b) => b[3]!));
  let hi = Math.max(...bars.map((b) => b[4]!), ...bars.map((b) => b[2]!));
  const near = (p: number) => p > lo - (hi - lo) * 0.4 && p < hi + (hi - lo) * 0.4;
  const extra: number[] = [];
  if (show.trades) for (const t of trades) extra.push(t.entry, ...(t.stop !== null ? [t.stop] : []), ...(t.target !== null ? [t.target] : []));
  if (live !== null && Number.isFinite(live)) extra.push(live);
  // v17.8: with trade labels on (one trade's own chart) its stop and target always fit on the chart
  for (const p of extra) if (near(p) || tradeLabels) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const pad = (hi - lo) * 0.06 || 0.0001;
  lo -= pad;
  hi += pad;
  const cw = W - padR;
  // v17.13: candles side by side (index), times mapped onto them
  const slot = cw / bars.length;
  const xi = (i: number) => (i + 0.5) * slot;
  const x = (t: number) => xOfTime(bars, t, slot, step);
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const bw = Math.max(1, slot * 0.7);
  // closed-market breaks (weekends, holidays): a gap of more than 3 candles and over 2 hours
  const breaks: number[] = [];
  for (let i = 1; i < bars.length; i++) if (bars[i]![0]! - bars[i - 1]![0]! > Math.max(3 * step, 2 * 3_600_000)) breaks.push(i);
  const last = live !== null && Number.isFinite(live) ? live : bars[bars.length - 1]![4]!;
  const ticks = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / 5);
  const clipY = (p: number) => Math.max(-2, Math.min(H + 2, y(p)));
  // v17.8: gutter labels (entry / stop / target + the live price), nudged so they never overlap
  const gutter = tradeLabels
    ? spreadLabels(
        [
          ...(show.trades
            ? trades.flatMap((t) => [
                { key: 'e', y: clipY(t.entry), text: t.entry.toFixed(digits), color: ENTRY, solid: false },
                ...(t.stop !== null ? [{ key: 's', y: clipY(t.stop), text: t.stop.toFixed(digits), color: STOP, solid: false }] : []),
                ...(t.target !== null ? [{ key: 't', y: clipY(t.target), text: t.target.toFixed(digits), color: TARGET, solid: false }] : []),
                ...(t.lockAt != null && Number.isFinite(t.lockAt) ? [{ key: 'l', y: clipY(t.lockAt), text: t.lockAt.toFixed(digits), color: LOCK, solid: false }] : []),
              ])
            : []),
          { key: 'live', y: y(last), text: last.toFixed(digits), color: ENTRY, solid: true },
        ].map((g, k) => ({ ...g, key: `${g.key}${k}` })),
        17,
        9,
        H - 9,
      )
    : [];
  const nTicks = Math.max(2, Math.min(6, Math.floor(cw / 90) + 1));
  const tickIdx = timeAxis ? [...new Set(Array.from({ length: nTicks }, (_, k) => Math.round((k * (bars.length - 1)) / (nTicks - 1))))] : [];
  const tickText = axisLabels(tickIdx.map((i) => bars[i]![0]!), step);
  const hb = hover !== null && hover < bars.length ? bars[hover] : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px > cw) return setHover(null);
    setHover(Math.max(0, Math.min(bars.length - 1, Math.floor(px / slot))));
  };
  const svg = (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className="h-auto w-full select-none"
      role="img"
      aria-label="Price chart with the bot's lines and trades"
      onPointerMove={interactive ? onMove : undefined}
      onPointerDown={interactive ? onMove : undefined}
      onPointerLeave={interactive ? () => setHover(null) : undefined}
      style={interactive ? { touchAction: 'pan-y' } : undefined}
    >
      {ticks.map((p) => (
        <g key={p}>
          <line x1={0} x2={cw} y1={y(p)} y2={y(p)} className="stroke-line" strokeWidth={1} />
          {(!tradeLabels || gutter.every((g) => Math.abs(g.ly - y(p)) > 15)) && <text x={W - 4} y={y(p) + 4} textAnchor="end" className="fill-muted text-[11px]">{p.toFixed(digits)}</text>}
        </g>
      ))}
      {breaks.map((i) => (
        <line key={`br${i}`} x1={i * slot} x2={i * slot} y1={0} y2={H} className="stroke-muted" strokeWidth={1} strokeDasharray="2 4" opacity={0.35} />
      ))}
      <defs>
        <clipPath id={clipId}><rect x={0} y={0} width={cw} height={H} /></clipPath>
      </defs>
      {/* v26.3: everything drawn on the plot stays inside it (lines that run off the price range used to spill over the
          price labels and the time axis, or got squashed flat at the edge) */}
      <g clipPath={`url(#${clipId})`}>
      {show.ranges && drawings?.prevDay && (
        <g>
          {[drawings.prevDay.h, drawings.prevDay.l].filter(near).map((p, k) => (
            <line key={k} x1={0} x2={cw} y1={y(p)} y2={y(p)} stroke="#a78bfa" strokeWidth={1} strokeDasharray="2 4" opacity={0.8} />
          ))}
        </g>
      )}
      {show.ranges && drawings?.asia && (
        <rect x={0} width={cw} y={y(drawings.asia.h)} height={Math.max(1, y(drawings.asia.l) - y(drawings.asia.h))} fill="#38bdf8" opacity={0.07} />
      )}
      {show.profile !== false && drawings?.profile && near(drawings.profile.poc) && (
        <g>
          <rect x={0} width={cw} y={y(drawings.profile.vah)} height={Math.max(1, y(drawings.profile.val) - y(drawings.profile.vah))} fill="#f59e0b" opacity={0.07} />
          {[drawings.profile.vah, drawings.profile.val].map((p, k) => <line key={k} x1={0} x2={cw} y1={y(p)} y2={y(p)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="1 3" opacity={0.8} />)}
          <line x1={0} x2={cw} y1={y(drawings.profile.poc)} y2={y(drawings.profile.poc)} stroke="#f59e0b" strokeWidth={1.5} opacity={0.9} />
          <text x={4} y={y(drawings.profile.poc) - 3} className="fill-muted text-[10px]" stroke="var(--surface)" strokeWidth={3} paintOrder="stroke">POC</text>
        </g>
      )}
      {show.channel !== false && drawings?.channel && (() => {
        const ch = drawings.channel;
        return [0, 2, -2].map((k) => {
          const pts = linePoints(bars, { t1: ch.t1, p1: ch.p1 + k * ch.sd, t2: ch.t2, p2: ch.p2 + k * ch.sd }, slot);
          if (!pts) return null;
          return <polyline key={`ch${k}`} points={pts.map(([px, pp]) => `${px.toFixed(1)},${y(pp).toFixed(1)}`).join(' ')} fill="none" stroke="#38bdf8" strokeWidth={k === 0 ? 1.5 : 1} strokeDasharray={k === 0 ? '6 4' : '2 3'} opacity={k === 0 ? 0.8 : 0.55} />;
        });
      })()}
      {show.levels && drawings?.levels.filter((l) => near(l.price)).map((l, k) => (
        <g key={k}>
          <line x1={0} x2={cw} y1={y(l.price)} y2={y(l.price)} stroke={l.kind === 'support' ? '#22c55e' : '#ef4444'} strokeWidth={1 + Math.min(2, l.touches / 3)} strokeDasharray="8 5" opacity={0.55} />
        </g>
      ))}
      {entryMarker && show.trades && trades.map((t, k) => {
        const inside = t.entryT >= t0;
        const xa = inside ? tradeAnchor(x(t.entryT), cw).marker : 0;
        const right = xa > cw - 90;
        return (
          <g key={`em${k}`}>
            {inside && <line x1={xa} x2={xa} y1={0} y2={H} stroke={ENTRY} strokeWidth={1} opacity={0.45} />}
            <text x={inside ? xa + (right ? -5 : 5) : 4} y={12} textAnchor={inside && right ? 'end' : 'start'} className="fill-muted text-[11px]" stroke="var(--surface)" strokeWidth={3} paintOrder="stroke">
              {inside ? `Entry ${clockOf(t.entryT, false)}` : `◂ entered ${clockOf(t.entryT, t1 - t.entryT > 20 * 3_600_000)}`}
            </text>
          </g>
        );
      })}
      {bars.map((b, i) => {
        const up = b[4]! >= b[1]!;
        const cx = xi(i);
        return (
          <g key={b[0]}>
            <line x1={cx} x2={cx} y1={y(b[2]!)} y2={y(b[3]!)} stroke={up ? '#16a34a' : '#dc2626'} strokeWidth={1} />
            <rect x={cx - bw / 2} width={bw} y={y(Math.max(b[1]!, b[4]!))} height={Math.max(1, Math.abs(y(b[1]!) - y(b[4]!)))} fill={up ? '#16a34a' : '#dc2626'} />
          </g>
        );
      })}
      {show.lines && drawings?.lines.map((l, k) => {
        // v26.3: through every candle from its first point to the right edge, cut at the plot by the clip
        const pts = linePoints(bars, l, slot);
        if (!pts) return null;
        return <polyline key={k} points={pts.map(([px, pp]) => `${px.toFixed(1)},${y(pp).toFixed(1)}`).join(' ')} fill="none" stroke={l.kind === 'support' ? '#22c55e' : '#ef4444'} strokeWidth={2} strokeLinejoin="round" strokeDasharray={l.broken ? '6 4' : undefined} opacity={0.9} />;
      })}
      </g>
      {show.trades && trades.map((t, k) => {
        const xe = Math.max(0, x(Math.max(t0, t.entryT)));
        // v17.8: one trade's own chart: lines always visible (see tradeAnchor), faint over the candles before the entry
        const xa = single ? tradeAnchor(xe, cw).solid : xe;
        const levels: Array<[number, string, boolean]> = [[t.entry, ENTRY, false], ...(t.stop !== null ? [[t.stop, STOP, true] as [number, string, boolean]] : []), ...(t.target !== null ? [[t.target, TARGET, true] as [number, string, boolean]] : [])];
        return (
          <g key={k}>
            {single && xa > 0 && levels.map(([p, c, dash], j) => <line key={`f${j}`} x1={0} x2={xa} y1={clipY(p)} y2={clipY(p)} stroke={c} strokeWidth={1} strokeDasharray={dash ? '4 3' : undefined} opacity={0.3} />)}
            <line x1={xa} x2={cw} y1={clipY(t.entry)} y2={clipY(t.entry)} stroke={ENTRY} strokeWidth={1.5} />
            {t.stop !== null && <line x1={xa} x2={cw} y1={clipY(t.stop)} y2={clipY(t.stop)} stroke={STOP} strokeWidth={1.5} strokeDasharray="4 3" />}
            {t.target !== null && <line x1={xa} x2={cw} y1={clipY(t.target)} y2={clipY(t.target)} stroke={TARGET} strokeWidth={1.5} strokeDasharray="4 3" />}
            {t.lockAt != null && Number.isFinite(t.lockAt) && <line x1={xa} x2={cw} y1={clipY(t.lockAt)} y2={clipY(t.lockAt)} stroke={LOCK} strokeWidth={1} strokeDasharray="2 3" />}
            <path d={t.side === 1 ? `M${xa} ${clipY(t.entry) + 12} l-6 8 h12 z` : `M${xa} ${clipY(t.entry) - 12} l-6 -8 h12 z`} fill={t.side === 1 ? '#16a34a' : '#dc2626'} />
          </g>
        );
      })}
      <line x1={0} x2={cw} y1={y(last)} y2={y(last)} stroke={ENTRY} strokeWidth={1} strokeDasharray="1 3" />
      {!tradeLabels && (
        <>
          <rect x={cw + 2} y={y(last) - 9} width={PAD_R - 4} height={18} rx={4} fill={ENTRY} />
          <text x={W - 6} y={y(last) + 4} textAnchor="end" className="fill-white text-[11px] font-semibold">{last.toFixed(digits)}</text>
        </>
      )}
      {gutter.map((g) => (
        <g key={g.key}>
          {Math.abs(g.ly - g.y) > 1 && <path d={`M${cw} ${g.y} L${cw + 4} ${g.ly}`} stroke={g.color} strokeWidth={1} fill="none" />}
          {g.solid ? (
            <rect x={cw + 4} y={g.ly - 8} width={padR - 6} height={16} rx={4} fill={g.color} />
          ) : (
            <>
              <rect x={cw + 4} y={g.ly - 8} width={padR - 6} height={16} rx={4} className="fill-surface-2" />
              <rect x={cw + 4} y={g.ly - 8} width={3} height={16} rx={1.5} fill={g.color} />
            </>
          )}
          <text x={W - 5} y={g.ly + 4} textAnchor="end" className={`text-[11px] font-semibold ${g.solid ? 'fill-white' : 'fill-ink'}`}>{g.text}</text>
        </g>
      ))}
      {timeAxis && tickIdx.map((i, k, a) =>
        tickText[k] ? (
          <text key={i} x={k === 0 ? 2 : k === a.length - 1 ? cw : xi(i)} y={height - 5} textAnchor={k === 0 ? 'start' : k === a.length - 1 ? 'end' : 'middle'} className="fill-muted text-[11px]">{tickText[k]}</text>
        ) : null,
      )}
      {hb && hover !== null && (
        <g pointerEvents="none">
          <line x1={xi(hover)} x2={xi(hover)} y1={0} y2={H} className="stroke-ink-2" strokeWidth={1} opacity={0.5} />
          <line x1={0} x2={cw} y1={y(hb[4]!)} y2={y(hb[4]!)} className="stroke-ink-2" strokeWidth={1} opacity={0.25} />
        </g>
      )}
    </svg>
  );
  if (!interactive) return svg;
  return (
    <div className="relative">
      {svg}
      {hb && (
        <div className="tabular pointer-events-none absolute left-1.5 top-5 rounded-md border border-line bg-surface/95 px-2 py-1 text-[11px] leading-tight text-ink-2 shadow-sm">
          <span className="font-semibold text-ink">{new Date(hb[0]!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span className="ml-1.5">O {hb[1]!.toFixed(digits)} · H {hb[2]!.toFixed(digits)} · L {hb[3]!.toFixed(digits)} · C <span className="font-semibold text-ink">{hb[4]!.toFixed(digits)}</span></span>
        </div>
      )}
    </div>
  );
}
