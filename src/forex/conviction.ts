/**
 * Bigger size when it is more sure (v15.2, owner: "take bigger leverage trades if it's more sure of its entry").
 * How sure the bot is of an entry = how many independent things back it at the signal close: the stronger currency
 * (strength gap ≥ 0.15 its way), the next bigger chart's trend with it, the chart above it not just "not against" but
 * with it, the market mood with it, and on the hourly / 4-hour charts the signal judge's score in the top 30% (+1) and
 * top 10% (+1 more) of its scores on the first 70%. 'sure' = 3+ of them, 'very sure' = 5+ (all 4 on the 15m / 1m
 * charts, which have no judge).
 * A tier only trades bigger after it proved itself on the UNSEEN last 30% of the history: there its trades made at
 * least 0.1R more per trade than all trades, on 60+ trades ('very sure' must also beat 'sure'; without a judge the
 * first 70% must point the same way). Bigger = 1.5× / 2× the normal risk (never above 2% of the account) at 50× / 100×
 * leverage. Until then every trade keeps its normal size. Pure.
 */
import { MOOD_MIN } from './mood';
import { RISK_TRADE, STRENGTH_MIN, type FilterEnv } from './filters';

export type Tier = 'normal' | 'sure' | 'verySure';

export const CONVICTION = {
  sure: { from: 3, mult: 1.5, lev: 50 },
  verySure: { from: 5, mult: 2, lev: 100 },
  /** 15m / 1m charts have no judge: 'very sure' = all four market checks */
  verySureNoJudge: 4,
  minN: 60,
  minGainR: 0.1,
  /** 'very sure' must beat 'sure' by this much */
  minStepR: 0.05,
  /** most risk one trade may carry with the boost, % of the account */
  maxRiskPct: 2,
  /** judge score cut points: top 30% / top 10% of its first-70% scores */
  pHiQ: 0.7,
  pTopQ: 0.9,
};
export const TIER_LABEL: Record<Tier, string> = { normal: 'normal', sure: 'sure', verySure: 'very sure' };

/** How many of the four market checks back this side at bar i (0–4; 4-hour charts have no next-bigger chart → max 3). Pure. */
export function agreeCount(e: FilterEnv, i: number, side: 1 | -1): number {
  let n = 0;
  const g = e.gap[i]!;
  if (Number.isFinite(g) && side * g >= STRENGTH_MIN) n++;
  if (e.tf !== '4h' && e.h4[i] === side) n++;
  if (e.d1[i] === side) n++;
  const m = e.mood[i]!;
  const exp = side * e.riskLong;
  if (Number.isFinite(m) && Math.abs(m) >= MOOD_MIN && Math.abs(exp) > RISK_TRADE && Math.sign(m) === Math.sign(exp)) n++;
  return n;
}

export interface Cuts {
  pHi: number | null;
  pTop: number | null;
}

/** Judge cut points from scores (the first 70% only). Pure. */
export function judgeCuts(ps: readonly number[]): Cuts {
  if (ps.length < 50) return { pHi: null, pTop: null };
  const s = Float64Array.from(ps).sort();
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]!;
  return { pHi: q(CONVICTION.pHiQ), pTop: q(CONVICTION.pTopQ) };
}

/** Confirmations: the market checks + the judge (0 / 1 / 2). Pure. */
export function confirmations(agree: number, p: number | null, cuts: Cuts): number {
  let n = agree;
  if (p !== null && cuts.pHi !== null && p >= cuts.pHi) n++;
  if (p !== null && cuts.pTop !== null && p >= cuts.pTop) n++;
  return n;
}

/** Most confirmations possible on a chart. Pure. */
export const maxConfirmations = (tf: string, judge: boolean) => (tf === '4h' ? 3 : 4) + (judge ? 2 : 0);

/** The tier of a number of confirmations. Pure. */
export function tierOf(conf: number, judge: boolean): Tier {
  if (conf >= (judge ? CONVICTION.verySure.from : CONVICTION.verySureNoJudge)) return 'verySure';
  if (conf >= CONVICTION.sure.from) return 'sure';
  return 'normal';
}

export interface TierStats {
  tier: Tier;
  label: string;
  /** confirmations needed */
  from: number;
  mult: number;
  lev: number;
  inN: number;
  inAvgR: number;
  outN: number;
  outAvgR: number;
  active: boolean;
}

export interface ConvictionReport {
  /** 'hourly' (1h + 4h), '15m', '1m' */
  scope: string;
  judge: boolean;
  cuts: Cuts;
  all: { inN: number; inAvgR: number; outN: number; outAvgR: number };
  /** 'sure' and 'very sure' (each counted with everything above it) */
  tiers: TierStats[];
  active: boolean;
  why: string;
}

export interface ConvRow {
  /** entry time */
  t: number;
  /** v17: exit time — only rows finished before the boundary count in the first 70% (default: the entry time) */
  exitT?: number;
  r: number;
  conf: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const avg = (xs: readonly ConvRow[]) => (xs.length ? xs.reduce((a, b) => a + b.r, 0) / xs.length : 0);

/**
 * Grade the tiers on trades of the strategies the bot would pick (first 70% picks): a tier is active only when it made
 * clearly more on the unseen part. `judge` = the confirmations include the judge's score. Pure.
 */
export function gradeConviction(rows: readonly ConvRow[], oosFrom: number, scope: string, judge: boolean, cuts: Cuts): ConvictionReport {
  const ins = rows.filter((x) => (x.exitT ?? x.t) < oosFrom);
  const out = rows.filter((x) => x.t >= oosFrom);
  const all = { inN: ins.length, inAvgR: r2(avg(ins)), outN: out.length, outAvgR: r2(avg(out)) };
  const stat = (tier: 'sure' | 'verySure', from: number): TierStats => {
    const i = ins.filter((x) => x.conf >= from);
    const o = out.filter((x) => x.conf >= from);
    const c = CONVICTION[tier];
    return { tier, label: TIER_LABEL[tier], from, mult: c.mult, lev: c.lev, inN: i.length, inAvgR: r2(avg(i)), outN: o.length, outAvgR: r2(avg(o)), active: false };
  };
  const sure = stat('sure', CONVICTION.sure.from);
  const very = stat('verySure', judge ? CONVICTION.verySure.from : CONVICTION.verySureNoJudge);
  const outBase = avg(out);
  const inBase = avg(ins);
  // without the judge the first 70% is a fair check too (with it, the judge has seen those trades: unseen only)
  const sameWay = (t: TierStats) => judge || t.inAvgR >= inBase;
  const EPS = 1e-9;
  const sureAvg = avg(out.filter((x) => x.conf >= sure.from));
  sure.active = sure.outN >= CONVICTION.minN && sureAvg >= outBase + CONVICTION.minGainR - EPS && sameWay(sure);
  very.active = sure.active && very.outN >= CONVICTION.minN && avg(out.filter((x) => x.conf >= very.from)) >= sureAvg + CONVICTION.minStepR - EPS && sameWay(very);
  const why = !rows.length
    ? 'no trades to judge yet'
    : sure.outN < CONVICTION.minN
      ? `only ${sure.outN} 'sure' trades on unseen data (needs ${CONVICTION.minN}): normal size for every trade`
      : !sure.active
        ? `on unseen data the 'sure' trades made ${sure.outAvgR}R each vs ${all.outAvgR}R for all: not clearly better, so no bigger size`
        : very.active
          ? `on unseen data 'sure' trades made ${sure.outAvgR}R and 'very sure' ${very.outAvgR}R each vs ${all.outAvgR}R for all: bigger size on both`
          : `on unseen data 'sure' trades made ${sure.outAvgR}R each vs ${all.outAvgR}R for all: bigger size when sure (${very.outN < CONVICTION.minN ? `too few 'very sure' trades (${very.outN})` : `'very sure' (${very.outAvgR}R) not clearly better than 'sure'`}, so it gets the 'sure' size)`;
  return { scope, judge, cuts, all, tiers: [sure, very], active: sure.active, why };
}

/** Size multiplier + leverage for a tier under a graded report (normal when the tier is not proven). Pure. */
export function boostFor(tier: Tier, rep: ConvictionReport | null | undefined): { tier: Tier; mult: number; lev: number | null } {
  if (!rep?.active || tier === 'normal') return { tier: 'normal', mult: 1, lev: null };
  const very = rep.tiers.find((t) => t.tier === 'verySure');
  if (tier === 'verySure' && very?.active) return { tier, mult: very.mult, lev: very.lev };
  const sure = rep.tiers.find((t) => t.tier === 'sure')!;
  return { tier: 'sure', mult: sure.mult, lev: sure.lev };
}
