/**
 * v16 sniper (owner: "one trade that makes a lot", built the quant-desk way: only after the pieces underneath prove
 * themselves). For every trade of a strategy the bot would pick, count how many INDEPENDENT checks agree at the signal
 * close: the four market checks of the conviction tiers (stronger currency, bigger chart, the chart above, market
 * mood), then the v16 engines — the momentum blend (1 / 5 / 20-day returns), carry (interest-rate gap), the volatility
 * forecast and the trend / chop measure fitting the strategy's style, hedge funds not crowded on that side (CFTC), room
 * to the next round number — and on the 1h / 4h charts the signal judge's score (top 30% +1, top 10% +1).
 * A vote level K is picked on the FIRST 70% only (the level with the best R per trade on 25+ trades, at least +0.25R);
 * the sniper turns on only if, on the UNSEEN 30%, trades with K+ votes made ≥ 0.3R each (and ≥ 0.25R more than all
 * trades) with a profit factor ≥ 1.5 on 15+ trades. Then those trades risk `SNIPER.riskPct` of the account (not the
 * mode's base) at `SNIPER.leverage`, one sniper trade at a time; otherwise nothing changes. Pure.
 */
import { agreeCount } from './conviction';
import { HURST_REVERT, HURST_TREND, VOLF_CALM, VOLF_UP, type FilterEnv } from './filters';
import { roundStep, type Style } from './strategies';
import type { Ctx } from './ta';

export const SNIPER = {
  /** risk per sniper trade, % of the account */
  riskPct: 8,
  leverage: 200,
  /** most sniper trades open at once */
  maxOpen: 1,
  minK: 6,
  maxK: 12,
  inMinN: 25,
  inMinAvgR: 0.25,
  outMinN: 15,
  outMinAvgR: 0.3,
  outMinGainR: 0.25,
  outMinPf: 1.5,
};

export interface SniperVotes {
  total: number;
  /** each vote that counted, in words (for the plan) */
  yes: string[];
  /** votes that had data (the most it could have reached without the judge) */
  of: number;
}

const fin = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);

/** The v16 votes on top of the market checks (no judge). Pure. */
export function extraVotes(c: Ctx, e: FilterEnv, i: number, side: 1 | -1, style: Style): SniperVotes {
  const yes: string[] = [];
  let of = 0;
  // momentum blend: 1-, 5- and 20-day returns, at least 2 of 3 with the trade
  const hs = [24, 120, 480].map((h) => Math.max(2, Math.round((h * 60) / c.barMin)));
  if (i >= hs[2]!) {
    of++;
    const m = hs.reduce((a, n) => a + Math.sign(c.close[i]! - c.close[i - n]!), 0);
    if (side * m >= 2) yes.push('momentum on 1, 5 and 20 days');
  }
  const cr = e.carry?.[i];
  if (fin(cr)) {
    of++;
    if (side * cr >= 0.5) yes.push(`earns carry (${(side * cr).toFixed(1)}% rate gap)`);
  }
  const v = e.volF?.[i];
  if (fin(v) && style !== 'pullback') {
    of++;
    if (style === 'revert' ? v <= VOLF_CALM : v >= VOLF_UP) yes.push(style === 'revert' ? 'volatility expected to calm' : 'volatility expected to rise');
  }
  const h = e.hurst?.[i];
  if (fin(h) && (style === 'trend' || style === 'revert')) {
    of++;
    if (style === 'trend' ? h >= HURST_TREND : h <= HURST_REVERT) yes.push(style === 'trend' ? 'moves have been continuing' : 'moves have been snapping back');
  }
  const pos = e.cot?.[i];
  if (fin(pos)) {
    of++;
    if (side * pos < 0.5) yes.push(side * pos <= -1 ? 'hedge funds positioned the other way (squeeze fuel)' : 'hedge funds not crowded on this side');
  }
  const step = roundStep(c.pair);
  const a = c.atr14[i]!;
  const px = c.close[i]!;
  if (step && fin(a) && a > 0) {
    of++;
    const next = side === 1 ? Math.floor(px / step) * step + step : Math.ceil(px / step) * step - step;
    if (Math.abs(next - px) >= a) yes.push('room to the next round number');
  }
  return { total: yes.length, yes, of };
}

/** All votes at bar i: market checks + extra votes + judge points (0–2). Pure. */
export function sniperVotes(c: Ctx, e: FilterEnv, i: number, side: 1 | -1, style: Style, judgePoints = 0): SniperVotes {
  const base = agreeCount(e, i, side);
  const ex = extraVotes(c, e, i, side, style);
  const yes = [...(base ? [`${base} market check${base > 1 ? 's' : ''} (strength, bigger charts, mood)`] : []), ...ex.yes, ...(judgePoints ? [`signal judge top ${judgePoints === 2 ? '10' : '30'}%`] : [])];
  return { total: base + ex.total + judgePoints, yes, of: (e.tf === '4h' ? 3 : 4) + ex.of };
}

export interface SniperRow {
  /** entry time */
  t: number;
  /** v17: exit time — only rows finished before the boundary count in the first 70% (default: the entry time) */
  exitT?: number;
  r: number;
  votes: number;
}

export interface SniperLevel {
  k: number;
  inN: number;
  inAvgR: number;
  outN: number;
  outAvgR: number;
  outPf: number | null;
}

export interface SniperReport {
  active: boolean;
  /** votes needed (picked on the first 70%), null = none qualified */
  k: number | null;
  levels: SniperLevel[];
  all: { inN: number; inAvgR: number; outN: number; outAvgR: number };
  riskPct: number;
  leverage: number;
  why: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const avg = (xs: readonly SniperRow[]) => (xs.length ? xs.reduce((s, x) => s + x.r, 0) / xs.length : 0);
const pf = (xs: readonly SniperRow[]) => {
  const w = xs.filter((x) => x.r > 0).reduce((s, x) => s + x.r, 0);
  const l = -xs.filter((x) => x.r < 0).reduce((s, x) => s + x.r, 0);
  return l > 0 ? w / l : w > 0 ? 99 : null;
};

/** Pick K on the first 70%, grade it once on the unseen 30%. Pure. */
export function gradeSniper(rows: readonly SniperRow[], oosFrom: number): SniperReport {
  const ins = rows.filter((x) => (x.exitT ?? x.t) < oosFrom);
  const out = rows.filter((x) => x.t >= oosFrom);
  const all = { inN: ins.length, inAvgR: r2(avg(ins)), outN: out.length, outAvgR: r2(avg(out)) };
  const levels: SniperLevel[] = [];
  for (let k = SNIPER.minK; k <= SNIPER.maxK; k++) {
    const i = ins.filter((x) => x.votes >= k);
    const o = out.filter((x) => x.votes >= k);
    const p = pf(o);
    levels.push({ k, inN: i.length, inAvgR: r2(avg(i)), outN: o.length, outAvgR: r2(avg(o)), outPf: p === null ? null : r2(p) });
  }
  const base = { riskPct: SNIPER.riskPct, leverage: SNIPER.leverage, levels, all };
  const cand = levels.filter((l) => l.inN >= SNIPER.inMinN && l.inAvgR >= SNIPER.inMinAvgR);
  if (!rows.length) return { ...base, active: false, k: null, why: 'no trades to judge yet' };
  if (!cand.length) return { ...base, active: false, k: null, why: `on the first 70% no vote level made ${SNIPER.inMinAvgR}R+ a trade on ${SNIPER.inMinN}+ trades: the checks agreeing doesn't pick better trades yet, so no sniper trades` };
  const pick = cand.reduce((b, l) => (l.inAvgR > b.inAvgR ? l : b));
  const o = out.filter((x) => x.votes >= pick.k);
  const oa = avg(o);
  const opf = pf(o) ?? 0;
  const EPS = 1e-9;
  const active = o.length >= SNIPER.outMinN && oa >= Math.max(SNIPER.outMinAvgR, avg(out) + SNIPER.outMinGainR) - EPS && opf >= SNIPER.outMinPf - EPS;
  const why = active
    ? `${pick.k}+ checks agreeing: ${r2(oa)}R a trade on ${o.length} unseen trades (all trades ${all.outAvgR}R), profit factor ${r2(opf)} → those trades risk ${SNIPER.riskPct}% of the account`
    : o.length < SNIPER.outMinN
      ? `${pick.k}+ checks looked best on the first 70% (${pick.inAvgR}R a trade), but only ${o.length} such trades in the unseen part (needs ${SNIPER.outMinN}): not proven, normal size`
      : `${pick.k}+ checks looked best on the first 70% (${pick.inAvgR}R a trade) but made ${r2(oa)}R on unseen data (needs ${Math.max(SNIPER.outMinAvgR, r2(avg(out) + SNIPER.outMinGainR))}R and profit factor ${SNIPER.outMinPf}): not proven, normal size`;
  return { ...base, active, k: pick.k, why };
}
