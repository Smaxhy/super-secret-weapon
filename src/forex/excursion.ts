/**
 * v27.45 (owner: "analyse all the trades it's taken and how much it bounced from loss to high — it often goes red for a bit
 * before it makes profit; how long on average it loses before it makes profit, how low it goes before it bounces; and
 * instead of a flat $20, calculate whether it could be $25 or $15 so the stop is smarter, based on trade performance").
 *
 * Pure. For every closed bot trade, read from the candles of its life:
 *  - how far it went against the entry (MAE, in USD and as a share of its tested 1R) and when,
 *  - how far it went its way (MFE),
 *  - for winners that dipped: how long to the bottom and how long from there back to break-even,
 *  - for trades the $ loss cap closed: what the TESTED trade did afterwards (target / tested stop / still open), up to
 *    `afterHours` later.
 * Then replay every trade under other loss caps ($10 … $50): a trade whose loss reached the cap ends at −cap, the others
 * keep what they did; a capped trade under a wider cap gets what its tested trade did after the old cap. The best cap
 * overall, per strategy × chart and per market is reported, and a suggested cap per strategy × chart is a blend of its
 * own best and the overall best (weight n ÷ (n + `blendK`)), rounded to `step`, kept within [minCap, maxCap].
 *
 * Approximations (said on the card): candle extremes don't say what happened first inside one candle (the adverse side
 * is assumed first — pessimistic), the first candle can hold prices from just before the entry, the replay ignores the
 * profit lock / trailing stops a different cap would have changed, and fees on the replayed −cap exits are not added.
 */
import type { Bar } from './types';

export const EXCURSION = {
  caps: [10, 12.5, 15, 17.5, 20, 22.5, 25, 30, 35, 40, 50],
  afterHours: 72,
  /** a strategy × chart needs this many analysed trades before its own best cap counts at all */
  minKey: 8,
  /** the suggestions only switch on with this many analysed trades on the account */
  minAll: 30,
  /** a cap other than today's is only suggested when it changes the result of this many trades … */
  minChanged: 3,
  /** … and makes at least this much more (USD) on them */
  minGainUsd: 10,
  blendK: 10,
  minCap: 10,
  maxCap: 40,
  step: 2.5,
  /** a winner "dipped" when it went at least this many USD red first */
  dipUsd: 5,
};

export interface ExTrade {
  id: string;
  pair: string;
  strategy?: string;
  tf?: string;
  side: 1 | -1;
  entry: number;
  stop: number | null;
  target: number | null;
  units: number;
  openedAt: number;
  closedAt: number;
  /** what the trade made in total (parts + rolls + this close) */
  usd: number;
  reason: string;
  /** USD lost at the TESTED stop, measured on the fill (1R) */
  riskUsd0?: number;
  allIn?: boolean;
  /** the $ loss cap this trade lived under (missing = the account's) */
  capUsd?: number;
}

export interface Excursion {
  id: string;
  pair: string;
  key: string;
  side: 1 | -1;
  openedAt: number;
  closedAt: number;
  usd: number;
  win: boolean;
  /** furthest it went against the entry during its life, USD (≥ 0) and as a share of its tested 1R */
  maeUsd: number;
  maeR: number | null;
  /** furthest it went its way, USD (≥ 0) */
  mfeUsd: number;
  /** minutes from the entry to the furthest-red candle */
  minsToMae: number;
  /** winners that dipped: minutes from the bottom back to a candle closing at / past the entry (null: never / not a dip) */
  minsBackToEven: number | null;
  /** the $ loss cap closed it */
  capped: boolean;
  /** capped trades: what its tested trade did afterwards */
  after: { kind: 'target' | 'stop' | 'open'; usd: number; hours: number } | null;
}

export interface CapRow {
  cap: number;
  n: number;
  usd: number;
  wins: number;
  losses: number;
  avg: number;
}

export interface ExcursionReport {
  at: number;
  n: number;
  currentCap: number;
  /** headline numbers */
  winners: { n: number; dipped: number; dippedPct: number; maeAvg: number; maeMedian: number; maeP75: number; maeP90: number; minsToMaeAvg: number; minsBackToEvenAvg: number | null; over: Record<string, number> };
  losers: { n: number; maeAvg: number; maeMedian: number };
  capped: { n: number; laterTarget: number; laterStop: number; stillOpen: number; missedUsd: number };
  caps: CapRow[];
  best: { cap: number; usd: number; vsCurrentUsd: number } | null;
  byKey: Array<{ key: string; n: number; winMaeP75: number | null; best: number | null; suggested: number }>;
  byPair: Array<{ pair: string; n: number; winMaeP75: number | null; best: number | null }>;
  /** the caps the bot uses (only when `active`) */
  suggest: { active: boolean; def: number; byKey: Record<string, number> };
  trades: Excursion[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (xs: readonly number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
};
const avg = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const keyOf = (t: Pick<ExTrade, 'strategy' | 'tf'>) => `${t.strategy ?? 'manual'}:${t.tf ?? ''}`;

/** one trade's path, read from the candles (bars sorted by time; `barMs` their length; `per` = USD per 1.0 price move
 * its way). `capUsd` = the loss cap it lived under (to spot trades the cap closed). */
export function excursionOf(t: ExTrade, bars: readonly Bar[], barMs: number, per: number, capUsd: number, k = EXCURSION): { ex: Excursion; path: Array<{ adv: number; fav: number; close: number; t: number }>; after: Array<{ adv: number; fav: number; close: number; t: number }>; targetUsd: number | null; testedUsd: number | null } | null {
  if (!(per > 0) || !bars.length) return null;
  const s = t.side;
  const adv = (b: Bar) => per * (s === 1 ? t.entry - b.l : b.h - t.entry);
  const fav = (b: Bar) => per * (s === 1 ? b.h - t.entry : t.entry - b.l);
  const cls = (b: Bar) => per * s * (b.c - t.entry);
  const life = bars.filter((b) => b.t + barMs > t.openedAt && b.t < t.closedAt);
  if (!life.length) return null;
  const path = life.map((b) => ({ adv: adv(b), fav: fav(b), close: cls(b), t: b.t }));
  let maeUsd = 0;
  let maeAt = t.openedAt;
  let maeI = -1;
  path.forEach((p, i) => {
    if (p.adv > maeUsd) {
      maeUsd = p.adv;
      maeAt = Math.max(t.openedAt, p.t);
      maeI = i;
    }
  });
  const mfeUsd = Math.max(0, ...path.map((p) => p.fav));
  const win = t.usd > 0;
  let minsBackToEven: number | null = null;
  if (win && maeUsd >= k.dipUsd && maeI >= 0) {
    const back = path.slice(maeI).find((p) => p.close >= 0);
    if (back) minsBackToEven = Math.max(0, Math.round((back.t + barMs - maeAt) / 60_000));
  }
  const d0 = t.riskUsd0 && t.riskUsd0 > 0 ? t.riskUsd0 : null;
  // the cap closed it: a stop at about −cap while the tested stop was clearly further away
  const cap0 = t.capUsd ?? capUsd;
  const capped = !t.allIn && t.reason === 'stop' && cap0 > 0 && t.usd <= -(cap0 * 0.85) && (d0 ?? 0) > cap0 * 1.15;
  // what the tested trade did after the cap closed it: tested stop (1R) or target, whichever the candles reach first
  const testedUsd = d0;
  const targetUsd = t.target !== null ? per * Math.abs(t.target - t.entry) : d0 ? 2 * d0 : null;
  let after: Excursion['after'] = null;
  let afterPath: Array<{ adv: number; fav: number; close: number; t: number }> = [];
  if (capped && testedUsd && targetUsd) {
    const end = t.closedAt + k.afterHours * 3_600_000;
    const later = bars.filter((b) => b.t + barMs > t.closedAt && b.t < end);
    afterPath = later.map((b) => ({ adv: adv(b), fav: fav(b), close: cls(b), t: b.t }));
    for (const p of afterPath) {
      if (p.adv >= testedUsd) {
        after = { kind: 'stop', usd: r2(-testedUsd), hours: Math.round((p.t - t.closedAt) / 3_600_000) };
        break;
      }
      if (p.fav >= targetUsd) {
        after = { kind: 'target', usd: r2(targetUsd), hours: Math.round((p.t - t.closedAt) / 3_600_000) };
        break;
      }
    }
    if (!after && afterPath.length) {
      const last = afterPath[afterPath.length - 1]!;
      after = { kind: 'open', usd: r2(last.close), hours: Math.round((last.t - t.closedAt) / 3_600_000) };
    }
  }
  return {
    ex: {
      id: t.id,
      pair: t.pair,
      key: keyOf(t),
      side: s,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      usd: r2(t.usd),
      win,
      maeUsd: r2(maeUsd),
      maeR: d0 ? r2(maeUsd / d0) : null,
      mfeUsd: r2(mfeUsd),
      minsToMae: Math.round((maeAt - t.openedAt) / 60_000),
      minsBackToEven,
      capped,
      after,
    },
    path,
    after: afterPath,
    targetUsd,
    testedUsd,
  };
}

/** what one trade would have made under loss cap `cap`. Pure. */
export function underCap(x: NonNullable<ReturnType<typeof excursionOf>>, t: Pick<ExTrade, 'allIn'>, cap: number): number {
  if (t.allIn) return x.ex.usd; // all-in trades never had the $ cap (their own tested stop)
  for (const p of x.path) if (p.adv >= cap) return -cap;
  if (!x.ex.capped) return x.ex.usd;
  // the old cap closed it but this one is wider: the trade lives on (as tested) until this cap, its tested stop or target
  // — only once its story is known (target / tested stop reached, or the whole look-ahead window has passed)
  if (x.ex.after?.kind === 'open' && x.ex.after.hours < EXCURSION.afterHours - 1) return x.ex.usd;
  const stopAt = Math.min(cap, x.testedUsd ?? cap);
  for (const p of x.after) {
    if (p.adv >= stopAt) return -stopAt;
    if (x.targetUsd !== null && p.fav >= x.targetUsd) return x.targetUsd;
  }
  return x.after.length ? Math.max(-stopAt, x.after[x.after.length - 1]!.close) : x.ex.usd;
}

/** the cap to use: the best one only when it beats `current` by `minGainUsd` on at least `minChanged` trades */
function provenCap(items: ReadonlyArray<{ x: NonNullable<ReturnType<typeof excursionOf>>; t: ExTrade }>, caps: readonly number[], current: number, k = EXCURSION): number {
  const best = bestCap(capTable(items, caps));
  if (!best || best.cap === current) return current;
  let changed = 0;
  let gain = 0;
  for (const { x, t } of items) {
    const d = underCap(x, t, best.cap) - underCap(x, t, current);
    if (Math.abs(d) > 0.5) changed++;
    gain += d;
  }
  return changed >= k.minChanged && gain >= k.minGainUsd ? best.cap : current;
}

const bestCap = (rows: readonly CapRow[]): CapRow | null => rows.reduce<CapRow | null>((b, r) => (!b || r.usd > b.usd + 1e-9 ? r : b), null);
const capTable = (items: ReadonlyArray<{ x: NonNullable<ReturnType<typeof excursionOf>>; t: ExTrade }>, caps: readonly number[]): CapRow[] =>
  caps.map((cap) => {
    const rs = items.map(({ x, t }) => underCap(x, t, cap));
    const usd = rs.reduce((a, b) => a + b, 0);
    return { cap, n: rs.length, usd: r2(usd), wins: rs.filter((v) => v > 0).length, losses: rs.filter((v) => v < 0).length, avg: rs.length ? r2(usd / rs.length) : 0 };
  });

/** the whole study. `barsOf(t)` = candles covering the trade (+ `afterHours`), `perOf(t)` = USD per 1.0 price move. */
export function excursionReport(trades: readonly ExTrade[], barsOf: (t: ExTrade) => { bars: readonly Bar[]; barMs: number }, perOf: (t: ExTrade) => number, currentCap: number, now: number, k = EXCURSION): ExcursionReport {
  const items: Array<{ x: NonNullable<ReturnType<typeof excursionOf>>; t: ExTrade }> = [];
  for (const t of trades) {
    const { bars, barMs } = barsOf(t);
    const x = excursionOf(t, bars, barMs, perOf(t), currentCap, k);
    if (x) items.push({ x, t });
  }
  const ex = items.map((i) => i.x.ex);
  const w = ex.filter((e) => e.win);
  const l = ex.filter((e) => !e.win);
  const dipped = w.filter((e) => e.maeUsd >= k.dipUsd);
  const backs = dipped.map((e) => e.minsBackToEven).filter((m): m is number => m !== null);
  const over: Record<string, number> = {};
  for (const lvl of [10, 15, 20, 25, 30]) over[String(lvl)] = w.filter((e) => e.maeUsd >= lvl).length;
  const capped = ex.filter((e) => e.capped);
  const caps = capTable(items, k.caps);
  const best = bestCap(caps);
  const cur = caps.find((c) => c.cap === currentCap) ?? capTable(items, [currentCap])[0]!;
  const round = (v: number) => Math.min(k.maxCap, Math.max(k.minCap, Math.round(v / k.step) * k.step));
  const allBest = provenCap(items, k.caps, currentCap, k);
  const active = ex.length >= k.minAll;
  const groups = <G extends string>(f: (t: ExTrade) => G) => {
    const m = new Map<G, typeof items>();
    for (const i of items) {
      const g = f(i.t);
      m.set(g, [...(m.get(g) ?? []), i]);
    }
    return m;
  };
  const byKey = [...groups((t) => keyOf(t)).entries()].map(([key, its]) => {
    const n = its.length;
    const wm = its.filter((i) => i.x.ex.win).map((i) => i.x.ex.maeUsd);
    const kb = n >= k.minKey ? provenCap(its, k.caps, allBest, k) : null;
    const wt = kb === null ? 0 : n / (n + k.blendK);
    const suggested = round(kb === null ? allBest : wt * kb + (1 - wt) * allBest);
    return { key, n, winMaeP75: wm.length ? r2(pct(wm, 0.75)) : null, best: kb, suggested };
  }).sort((a, b) => b.n - a.n);
  const byPair = [...groups((t) => t.pair).entries()].map(([pair, its]) => {
    const wm = its.filter((i) => i.x.ex.win).map((i) => i.x.ex.maeUsd);
    return { pair, n: its.length, winMaeP75: wm.length ? r2(pct(wm, 0.75)) : null, best: its.length >= k.minKey ? bestCap(capTable(its, k.caps))?.cap ?? null : null };
  }).sort((a, b) => b.n - a.n);
  return {
    at: now,
    n: ex.length,
    currentCap,
    winners: {
      n: w.length,
      dipped: dipped.length,
      dippedPct: w.length ? Math.round((100 * dipped.length) / w.length) : 0,
      maeAvg: r2(avg(w.map((e) => e.maeUsd))),
      maeMedian: r2(pct(w.map((e) => e.maeUsd), 0.5)),
      maeP75: r2(pct(w.map((e) => e.maeUsd), 0.75)),
      maeP90: r2(pct(w.map((e) => e.maeUsd), 0.9)),
      minsToMaeAvg: Math.round(avg(dipped.map((e) => e.minsToMae))),
      minsBackToEvenAvg: backs.length ? Math.round(avg(backs)) : null,
      over,
    },
    losers: { n: l.length, maeAvg: r2(avg(l.map((e) => e.maeUsd))), maeMedian: r2(pct(l.map((e) => e.maeUsd), 0.5)) },
    capped: {
      n: capped.length,
      laterTarget: capped.filter((e) => e.after?.kind === 'target').length,
      laterStop: capped.filter((e) => e.after?.kind === 'stop').length,
      stillOpen: capped.filter((e) => e.after?.kind === 'open').length,
      missedUsd: r2(capped.filter((e) => e.after?.kind === 'target').reduce((n, e) => n + (e.after!.usd - e.usd), 0)),
    },
    caps,
    best: best ? { cap: best.cap, usd: best.usd, vsCurrentUsd: r2(best.usd - cur.usd) } : null,
    byKey,
    byPair,
    suggest: { active, def: active ? round(allBest) : currentCap, byKey: active ? Object.fromEntries(byKey.map((b) => [b.key, b.suggested])) : {} },
    trades: ex.sort((a, b) => b.closedAt - a.closedAt).slice(0, 200),
  };
}
