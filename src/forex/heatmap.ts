/**
 * v16 heatmap per market: where orders are likely to sit near the price, and what the quant engines read right now.
 *  - Levels: big round numbers (stop-loss orders cluster just beyond them, take-profits at them — Osler, NY Fed) and
 *    half figures, swing-point clusters the price respected, yesterday's high / low, and today's big option expiries
 *    (ForexLive; price is often pulled toward large ones into the 10:00 New York cut). Weight = how much tends to sit
 *    there; distance in hourly ATRs.
 *  - Read: hedge-fund positioning (CFTC, ±2), carry (rate gap %), volatility forecast, trend / chop (Hurst), and how
 *    many sniper checks a long / a short would have at the last close.
 * Expiries are live-only (no history to test them on); everything else that feeds a trade is tested by the lab. Pure.
 */
import type { Drawings } from './drawings';
import type { Expiry } from './headlines';
import type { FilterEnv } from './filters';
import { sniperVotes } from './sniper';
import { roundStep } from './strategies';
import type { Ctx } from './ta';

export interface HeatLevel {
  price: number;
  kind: 'round' | 'half' | 'swing' | 'yesterday' | 'expiry';
  label: string;
  /** 1 (a little) … 5 (a lot) */
  weight: number;
  /** signed distance from the price in hourly ATRs (+ above) */
  distAtr: number;
}

export interface HeatRead {
  /** CFTC positioning of the pair, −2 (hedge funds very short) … +2 (very long); null = no data */
  positioning: number | null;
  /** policy rate of the base − the quote, %; null = no rates feed */
  carry: number | null;
  /** volatility forecast ratio (> 1 bigger moves expected) */
  volF: number | null;
  /** Hurst: > 0.5 moves continue, < 0.5 they snap back */
  hurst: number | null;
  /** sniper checks a long / a short would have now (judge not counted), out of `of` */
  long: number;
  short: number;
  of: number;
  /** the votes in words for the side with more */
  why: string[];
}

export interface Heatmap {
  levels: HeatLevel[];
  read: HeatRead;
}

const fin = (x: number | undefined): number | null => (x !== undefined && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** Heatmap at the last bar of an hourly series. Pure. */
export function heatmapFor(c: Ctx, e: FilterEnv, dr: Drawings, expiries: readonly Expiry[], range = 4): Heatmap {
  const n = c.bars.length;
  const i = n - 1;
  const px = c.close[i]!;
  const a = c.atr14[i]!;
  const levels: HeatLevel[] = [];
  const push = (price: number, kind: HeatLevel['kind'], label: string, weight: number) => {
    if (!(a > 0)) return;
    const d = (price - px) / a;
    if (Math.abs(d) > range) return;
    const near = levels.find((l) => Math.abs(l.price - price) < 0.15 * a);
    if (near) {
      near.weight = Math.min(5, near.weight + weight * 0.5);
      if (!near.label.includes(label)) near.label += ` + ${label}`;
      return;
    }
    levels.push({ price, kind, label, weight: Math.min(5, weight), distAtr: Math.round(d * 100) / 100 });
  };
  const step = roundStep(c.pair);
  if (step && a > 0) {
    const lo = Math.floor((px - range * a) / (step / 2));
    const hi = Math.ceil((px + range * a) / (step / 2));
    for (let k = lo; k <= hi; k++) {
      const p = k * (step / 2);
      const whole = k % 2 === 0;
      push(p, whole ? 'round' : 'half', whole ? 'round number' : 'half figure', whole ? 3 : 1.5);
    }
  }
  for (const l of dr.levels) push(l.price, 'swing', `${l.kind} (${l.touches} touches)`, Math.min(4, 1 + l.touches * 0.5));
  if (dr.prevDay) {
    push(dr.prevDay.h, 'yesterday', "yesterday's high", 2);
    push(dr.prevDay.l, 'yesterday', "yesterday's low", 2);
  }
  for (const x of expiries) if (x.pair === c.pair) push(x.level, 'expiry', `option expiry${x.sizeBn ? ` ${x.sizeBn}bn` : ''} (10:00 NY cut)`, 1.5 + Math.min(3.5, x.sizeBn ?? 0.5));
  levels.sort((x, y) => y.price - x.price);
  const vl = sniperVotes(c, e, i, 1, 'neutral');
  const vs = sniperVotes(c, e, i, -1, 'neutral');
  return {
    levels,
    read: {
      positioning: fin(e.cot?.[i]),
      carry: fin(e.carry?.[i]),
      volF: fin(e.volF?.[i]),
      hurst: fin(e.hurst?.[i]),
      long: vl.total,
      short: vs.total,
      of: Math.max(vl.of, vs.of),
      why: vl.total >= vs.total ? vl.yes : vs.yes,
    },
  };
}
