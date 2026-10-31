/**
 * v28.16 funding carry, graded like everything else (owner: "build it" — the one idea go-trader's research found positive,
 * `delta_neutral_funding` #1326: +1.1…+2.4% a leg, 84–95% of it funding, 2023–24 only).
 *
 * The trade: hold N coins (spot) AND short N coins on the perpetual future. Price moves cancel (same units on both legs); the
 * short collects funding while funding is positive and PAYS it while negative. Entry when the last 7 days' average funding
 * (annualised) is above a threshold, exit when it falls under the exit threshold.
 *
 * Money: capital = spot notional + the perp's margin (notional ÷ leverage). Costs per round trip: spot fee + perp fee + half
 * the spread on each leg, in and out. Liquidation: the price rising past the perp's margin (entry × (1 + 1/lev − mmr)) while
 * in → the perp leg is closed there with a liquidation fee and the carry restarts at the next settlement (re-entry costs again).
 *
 * NOT modelled (told on the card): the perp − spot price gap (basis) — the hedge is exact only if both legs trade at the same
 * price; funding from Binance / Bybit (Hyperliquid pays hourly and its rates differ); borrow / transfer costs between venues.
 *
 * Honest test: the rule (entry / exit thresholds) is picked on the FIRST 70% of the funding history (one rule for every coin),
 * graded once on the unseen 30%. Pure.
 */

export const CARRY = {
  /** fees per side, % of the notional: spot taker (Coinbase Advanced / Binance spot ≈ 0.1), perp taker (Hyperliquid base 0.045) */
  spotFeePct: 0.1,
  perpFeePct: 0.045,
  /** half spread per leg per side, % */
  halfSpreadPct: 0.02,
  leverage: 2,
  mmrPct: 2,
  liqFeePct: 1,
  /** look-back for the average funding (7 days) */
  avgDays: 7,
  /** entry thresholds tried (annualised %), exit = entry × each of these */
  entryApy: [5, 10, 15, 20, 30, 50],
  exitShare: [0, 0.5],
  oosFraction: 0.3,
  /** picked on the first 70%: at least this many days in a trade there */
  minDaysIn: 60,
  /** verdict 'edge': unseen ≥ 26 weeks, return on capital ≥ this % a year, first part positive, ≥ half the coins positive */
  minUnseenWeeks: 26,
  minApy: 3,
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

export interface CarryBar { t: number; h: number; c: number }
export interface CarryCoin { id: string; fund: ReadonlyArray<readonly [number, number]>; bars: readonly CarryBar[] }
export interface CarryRule { entryApy: number; exitApy: number }

export interface CarryTrade {
  id: string;
  open: number;
  close: number;
  /** % of capital */
  fundPct: number;
  costPct: number;
  netPct: number;
  liquidated: boolean;
}

export interface CarryStats {
  trades: number;
  daysIn: number;
  days: number;
  /** % of capital over the stretch (simple sum of trades) */
  totalPct: number;
  /** return on capital a year (totalPct ÷ years of the stretch) */
  apy: number;
  fundPct: number;
  costPct: number;
  liquidations: number;
  weeks: number;
  greenWeekPct: number;
  worstWeekPct: number;
}

export interface CarryCoinRow { id: string; first: CarryStats; unseen: CarryStats }

export interface CarryReport {
  at: number;
  coins: number;
  from: number;
  oosFrom: number;
  to: number;
  rule: CarryRule | null;
  /** every rule tried, first 70% numbers (pooled) */
  tried: Array<CarryRule & { firstApy: number; daysIn: number }>;
  first: CarryStats | null;
  unseen: CarryStats | null;
  /** always in (no threshold) on the unseen part — the yardstick */
  always: CarryStats | null;
  byCoin: CarryCoinRow[];
  verdict: 'edge' | 'maybe' | 'no' | 'none';
  why: string;
  recent: CarryTrade[];
  /** today: each coin's 7-day average funding (annualised %) and whether the rule would be in */
  now: Array<{ id: string; apy: number; inNow: boolean }>;
  notModelled: string[];
}

/** Settlements per year from the spacing of the rows (8-hour on most, 1- or 4-hour on some). */
function perYear(rows: ReadonlyArray<readonly [number, number]>, i: number): number {
  const gap = i > 0 ? rows[i]![0] - rows[i - 1]![0] : 8 * HOUR;
  return YEAR / Math.max(HOUR, Math.min(8 * HOUR, gap));
}

/** Annualised 7-day average funding at each settlement (only rows ≤ that time). Pure. */
export function avgApy(rows: ReadonlyArray<readonly [number, number]>, days = CARRY.avgDays): number[] {
  const out: number[] = new Array(rows.length).fill(NaN);
  let lo = 0;
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < rows.length; i++) {
    const y = perYear(rows, i);
    const r = rows[i]!;
    sum += r[1] * y;
    wsum += 1;
    while (rows[lo]![0] <= r[0] - days * DAY) {
      sum -= rows[lo]![1] * perYear(rows, lo);
      wsum -= 1;
      lo++;
    }
    if (r[0] - rows[0]![0] >= days * DAY && wsum > 0) out[i] = sum / wsum;
  }
  return out;
}

/** Simulate the rule on one coin between `from` and `to` (trades opened in the window, closed at its end at the latest). Pure. */
export function simulateCarry(coin: CarryCoin, rule: CarryRule, from: number, to: number, cfg = CARRY): CarryTrade[] {
  const rows = coin.fund;
  const apy = avgApy(rows, cfg.avgDays);
  const bars = coin.bars;
  const lev = cfg.leverage;
  // capital per unit notional: spot 1 + margin 1/lev
  const capital = 1 + 1 / lev;
  const sidePct = cfg.spotFeePct + cfg.perpFeePct + 2 * cfg.halfSpreadPct;
  const out: CarryTrade[] = [];
  let bi = 0;
  const priceAt = (t: number): number => {
    while (bi + 1 < bars.length && bars[bi + 1]!.t <= t) bi++;
    const b = bars[bi];
    return b && b.t <= t ? b.c : NaN;
  };
  let open: { t: number; px: number; liqPx: number; fund: number; cost: number } | null = null;
  let hiFrom = 0;
  const close = (t: number, liquidated: boolean): void => {
    if (!open) return;
    const cost = open.cost + (liquidated ? cfg.liqFeePct + sidePct : sidePct);
    out.push({ id: coin.id, open: open.t, close: t, fundPct: (open.fund / capital), costPct: cost / capital, netPct: (open.fund - cost) / capital, liquidated });
    open = null;
  };
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const t = row[0];
    if (t < from) continue;
    if (t > to) break;
    const px = priceAt(t);
    if (!(px > 0)) continue;
    if (open) {
      // liquidation: the price's high since the last settlement crossed the perp's margin
      let hi = px;
      for (let k = hiFrom; k < bars.length && bars[k]!.t <= t; k++) if (bars[k]!.t > open.t) hi = Math.max(hi, bars[k]!.h);
      hiFrom = Math.max(hiFrom, bi);
      if (hi >= open.liqPx) {
        close(t, true);
        continue;
      }
      // funding on the perp short: + rate × notional now (notional in entry units: units × price ÷ entry price)
      open.fund += row[1] * (px / open.px);
      const a = apy[i]!;
      if (Number.isFinite(a) && a < rule.exitApy) close(t, false);
    } else {
      const a = apy[i]!;
      if (Number.isFinite(a) && a >= rule.entryApy) {
        open = { t, px, liqPx: px * (1 + 1 / lev - cfg.mmrPct / 100), fund: 0, cost: sidePct };
        hiFrom = bi;
      }
    }
  }
  if (open) close(Math.min(to, rows[rows.length - 1]?.[0] ?? to), false);
  return out;
}

/** Stats of trades over a stretch (weekly results by the week each trade closed in). Pure. */
export function carryStats(trades: readonly CarryTrade[], from: number, to: number, coins: number): CarryStats {
  const days = Math.max(1, (to - from) / DAY);
  const W = 7 * DAY;
  const nW = Math.max(1, Math.floor((to - from) / W));
  const weeks = new Array(nW).fill(0);
  let total = 0;
  let fund = 0;
  let cost = 0;
  let daysIn = 0;
  let liq = 0;
  for (const tr of trades) {
    // a pooled book holds one equal slice per coin → each coin's % counts ÷ coins
    const share = 1 / Math.max(1, coins);
    total += tr.netPct * share;
    fund += tr.fundPct * share;
    cost += tr.costPct * share;
    daysIn += (tr.close - tr.open) / DAY;
    if (tr.liquidated) liq++;
    const w = Math.min(nW - 1, Math.max(0, Math.floor((tr.close - from) / W)));
    weeks[w] = (weeks[w] ?? 0) + tr.netPct * share;
  }
  const green = weeks.filter((x) => x > 0).length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    trades: trades.length,
    daysIn: Math.round(daysIn),
    days: Math.round(days),
    totalPct: r2(total),
    apy: r2(total / (days / 365)),
    fundPct: r2(fund),
    costPct: r2(cost),
    liquidations: liq,
    weeks: nW,
    greenWeekPct: Math.round((green / nW) * 100),
    worstWeekPct: r2(Math.min(0, ...weeks)),
  };
}

/** The whole test: pick a rule on the first 70%, grade once on the unseen 30%. Pure. */
export function carryTest(coins: readonly CarryCoin[], now: number, cfg = CARRY): CarryReport {
  const notModelled = [
    'the perp − spot price gap (basis) at entry / exit',
    'funding read from Binance / Bybit; Hyperliquid pays hourly at its own rates',
    'moving money between the spot and the futures account',
  ];
  const use = coins.filter((c) => c.fund.length > 50 && c.bars.length > 50);
  const empty: CarryReport = { at: now, coins: use.length, from: 0, oosFrom: 0, to: 0, rule: null, tried: [], first: null, unseen: null, always: null, byCoin: [], verdict: 'none', why: 'no funding history yet', recent: [], now: [], notModelled };
  if (!use.length) return empty;
  const from = Math.max(Math.min(...use.map((c) => c.fund[0]![0])), Math.min(...use.map((c) => c.bars[0]!.t)));
  const to = Math.max(...use.map((c) => c.fund[c.fund.length - 1]![0]));
  if (!(to > from + 60 * DAY)) return { ...empty, why: 'too little funding history' };
  const oosFrom = from + (1 - cfg.oosFraction) * (to - from);
  const n = use.length;
  const tried: CarryReport['tried'] = [];
  let best: { rule: CarryRule; apy: number } | null = null;
  for (const e of cfg.entryApy) {
    for (const s of cfg.exitShare) {
      const rule = { entryApy: e, exitApy: e * s };
      const tr = use.flatMap((c) => simulateCarry(c, rule, from, oosFrom, cfg));
      const st = carryStats(tr, from, oosFrom, n);
      tried.push({ ...rule, firstApy: st.apy, daysIn: st.daysIn });
      if (st.daysIn >= cfg.minDaysIn && (!best || st.apy > best.apy)) best = { rule, apy: st.apy };
    }
  }
  const nowRows = use.map((c) => {
    const a = avgApy(c.fund, cfg.avgDays);
    const last = a[a.length - 1] ?? NaN;
    return { id: c.id, apy: Math.round((Number.isFinite(last) ? last : 0) * 10) / 10, inNow: !!best && Number.isFinite(last) && last >= (best as { rule: CarryRule }).rule.entryApy };
  });
  if (!best) return { ...empty, from, oosFrom, to, tried, now: nowRows, why: 'no rule stayed in a trade long enough on the first 70%' };
  const rule = best.rule;
  const firstTr = use.flatMap((c) => simulateCarry(c, rule, from, oosFrom, cfg));
  const unseenTr = use.flatMap((c) => simulateCarry(c, rule, oosFrom, to, cfg));
  const first = carryStats(firstTr, from, oosFrom, n);
  const unseen = carryStats(unseenTr, oosFrom, to, n);
  const always = carryStats(use.flatMap((c) => simulateCarry(c, { entryApy: -1e9, exitApy: -1e9 }, oosFrom, to, cfg)), oosFrom, to, n);
  const byCoin = use.map((c) => ({
    id: c.id,
    first: carryStats(simulateCarry(c, rule, from, oosFrom, cfg), from, oosFrom, 1),
    unseen: carryStats(simulateCarry(c, rule, oosFrom, to, cfg), oosFrom, to, 1),
  }));
  const posCoins = byCoin.filter((r) => r.unseen.totalPct > 0).length;
  let verdict: CarryReport['verdict'];
  let why: string;
  if (unseen.weeks < cfg.minUnseenWeeks) {
    verdict = 'none';
    why = `only ${unseen.weeks} unseen weeks (needs ${cfg.minUnseenWeeks})`;
  } else if (unseen.apy >= cfg.minApy && first.totalPct > 0 && posCoins * 2 >= n) {
    verdict = 'edge';
    why = `unseen ${unseen.apy}% a year on the capital, first part positive, ${posCoins} of ${n} coins positive`;
  } else if (unseen.totalPct > 0 && first.totalPct > 0) {
    verdict = 'maybe';
    why = `positive on both parts but ${unseen.apy}% a year unseen (needs ${cfg.minApy}%) or only ${posCoins} of ${n} coins positive`;
  } else {
    verdict = 'no';
    why = unseen.totalPct <= 0 ? `lost on the unseen part (${unseen.totalPct}%)` : 'lost on the first part';
  }
  const recent = [...unseenTr].sort((a, b) => b.close - a.close).slice(0, 12);
  return { at: now, coins: n, from, oosFrom, to, rule, tried, first, unseen, always, byCoin, verdict, why, recent, now: nowRows, notModelled };
}
