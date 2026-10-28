/**
 * v27.24 confluence test (owner: "if you think doubling up is worth it, try it in the lab"). When two different
 * strategies fire the same way on the same market within a couple of candles, does that trade win more than a lone
 * signal? Graded like everything else: the trades of the strategies the bot would pick (picked on the first 70%),
 * compared on the first 70% (finished before the line) and on the unseen 30%. Only when the unseen part says yes — and
 * the first part points the same way — does the bot size a confluent trade up, as ONE bigger trade (the one-bet-per-
 * market-and-direction rule stays). Pure.
 */
export interface ConfTrade {
  key: string;
  pair: string;
  side: 1 | -1;
  entryT: number;
  exitT: number;
  r: number;
  barMs: number;
}

export interface ConfSide {
  n: number;
  avgR: number | null;
}
export interface ConfluenceReport {
  at: number;
  first: { together: ConfSide; alone: ConfSide };
  unseen: { together: ConfSide; alone: ConfSide };
  active: boolean;
  mult: number;
  why: string;
}

export const CONFLUENCE = {
  /** another strategy's entry within this many of the trade's own candles counts as "together" */
  bars: 2,
  minUnseen: 60,
  minEdgeR: 0.1,
  /** a confluent trade risks this multiple of its normal size (still under the mode's sure-trade cap) */
  mult: 1.5,
};

const side = (rs: number[]): ConfSide => ({ n: rs.length, avgR: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 1000) / 1000 : null });

/** Is another strategy's trade on the same market and direction entering within `bars` candles of this one? Pure. */
export function isTogether(t: Pick<ConfTrade, 'key' | 'pair' | 'side' | 'entryT' | 'barMs'>, others: readonly Pick<ConfTrade, 'key' | 'pair' | 'side' | 'entryT'>[], bars = CONFLUENCE.bars): boolean {
  const strat = t.key.split(':')[0];
  // v27.90 (code review): only mates that entered at or BEFORE this trade (within `bars` candles) — a later one can't be
  // seen live when the trade opens, so counting it graded the rule with look-ahead
  return others.some((o) => o.pair === t.pair && o.side === t.side && o.key.split(':')[0] !== strat && o.entryT <= t.entryT && t.entryT - o.entryT <= bars * t.barMs);
}

export function confluenceStudy(trades: readonly ConfTrade[], oosFrom: number, now = Date.now()): ConfluenceReport {
  const byPair = new Map<string, ConfTrade[]>();
  for (const t of trades) {
    const a = byPair.get(t.pair) ?? [];
    a.push(t);
    byPair.set(t.pair, a);
  }
  const fT: number[] = [], fA: number[] = [], uT: number[] = [], uA: number[] = [];
  for (const t of trades) {
    const together = isTogether(t, byPair.get(t.pair) ?? []);
    if (t.entryT >= oosFrom) (together ? uT : uA).push(t.r);
    else if (t.exitT < oosFrom) (together ? fT : fA).push(t.r);
  }
  const first = { together: side(fT), alone: side(fA) };
  const unseen = { together: side(uT), alone: side(uA) };
  const dU = unseen.together.avgR !== null && unseen.alone.avgR !== null ? unseen.together.avgR - unseen.alone.avgR : null;
  const dF = first.together.avgR !== null && first.alone.avgR !== null ? first.together.avgR - first.alone.avgR : null;
  let why: string;
  let active = false;
  if (unseen.together.n < CONFLUENCE.minUnseen) why = `too few double signals on the unseen part (${unseen.together.n}, needs ${CONFLUENCE.minUnseen}) — normal size`;
  else if (dU === null || dU < CONFLUENCE.minEdgeR) why = `double signals did not win more on the unseen part (${fmt(unseen.together.avgR)} vs alone ${fmt(unseen.alone.avgR)} a trade) — normal size`;
  else if (dF === null || dF <= 0) why = `better on the unseen part but not before it (${fmt(first.together.avgR)} vs ${fmt(first.alone.avgR)}) — could be luck, normal size`;
  else {
    active = true;
    why = `double signals won more on both parts (unseen ${fmt(unseen.together.avgR)} vs ${fmt(unseen.alone.avgR)}, before ${fmt(first.together.avgR)} vs ${fmt(first.alone.avgR)}) — they trade ${CONFLUENCE.mult}× the size as one trade`;
  }
  return { at: now, first, unseen, active, mult: active ? CONFLUENCE.mult : 1, why };
}

const fmt = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);

/**
 * v27.86 the clash test (owner, after a BTC 4h long stopped out while three 4h strategies fired SHORT on the same candle:
 * "that was a stupid trade going long against BTC like that"). When another strategy entered the OTHER way on the same
 * market within a couple of candles, does the trade lose more than one nobody argued with? Same grading as the
 * confluence test: the picked strategies' trades, first 70% (finished before the line) and the unseen 30%, opponents =
 * every strategy's tested trades (as the live check sees every strategy's open lab trades). Only when the unseen part
 * says clashing trades do worse — and the first part points the same way — does the bot skip them. Pure.
 */
export interface SideEntry {
  strategy: string;
  pair: string;
  side: 1 | -1;
  entryT: number;
}
export interface OpposedReport {
  at: number;
  first: { opposed: ConfSide; clear: ConfSide };
  unseen: { opposed: ConfSide; clear: ConfSide };
  active: boolean;
  why: string;
}
export const OPPOSED = {
  /** v27.88 (owner: "never do that again"): skip clashing trades always, not only once the lab test says so (the test
   * keeps measuring and reporting) */
  always: true,
  bars: 2,
  minUnseen: 60,
  /** clear trades must beat clashing ones by this much a trade on the unseen part */
  minEdgeR: 0.1,
};

/** Entries per market, sorted by time, for fast window lookups. */
export function entryIndex(all: readonly SideEntry[]): Map<string, SideEntry[]> {
  const m = new Map<string, SideEntry[]>();
  for (const e of all) {
    const a = m.get(e.pair) ?? [];
    a.push(e);
    m.set(e.pair, a);
  }
  for (const a of m.values()) a.sort((x, y) => x.entryT - y.entryT);
  return m;
}

/** The first other strategy that entered the other way on this market within `bars` candles of t, else null. Pure. */
export function opposedBy(t: { strategy: string; pair: string; side: 1 | -1; entryT: number }, idx: Map<string, SideEntry[]>, barMs: number, bars = OPPOSED.bars): SideEntry | null {
  const a = idx.get(t.pair);
  if (!a?.length) return null;
  const span = bars * barMs;
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]!.entryT < t.entryT - span) lo = mid + 1;
    else hi = mid;
  }
  // v27.90: entered at or before this trade only (no look-ahead)
  for (let i = lo; i < a.length && a[i]!.entryT <= t.entryT; i++) {
    const o = a[i]!;
    if (o.side !== t.side && o.strategy !== t.strategy && o.strategy !== 'random') return o;
  }
  return null;
}

export function opposedStudy(picked: readonly ConfTrade[], idx: Map<string, SideEntry[]>, oosFrom: number, now = Date.now()): OpposedReport {
  const fO: number[] = [], fC: number[] = [], uO: number[] = [], uC: number[] = [];
  for (const t of picked) {
    const opp = !!opposedBy({ strategy: t.key.split(':')[0]!, pair: t.pair, side: t.side, entryT: t.entryT }, idx, t.barMs);
    if (t.entryT >= oosFrom) (opp ? uO : uC).push(t.r);
    else if (t.exitT < oosFrom) (opp ? fO : fC).push(t.r);
  }
  const first = { opposed: side(fO), clear: side(fC) };
  const unseen = { opposed: side(uO), clear: side(uC) };
  const dU = unseen.opposed.avgR !== null && unseen.clear.avgR !== null ? unseen.clear.avgR - unseen.opposed.avgR : null;
  const dF = first.opposed.avgR !== null && first.clear.avgR !== null ? first.clear.avgR - first.opposed.avgR : null;
  let why: string;
  let active = false;
  if (unseen.opposed.n < OPPOSED.minUnseen) why = `too few clashing trades on the unseen part (${unseen.opposed.n}, needs ${OPPOSED.minUnseen}) — clashes still trade`;
  else if (dU === null || dU < OPPOSED.minEdgeR) why = `trades with a strategy firing the other way did not do worse on the unseen part (${fmt(unseen.opposed.avgR)} vs ${fmt(unseen.clear.avgR)} without) — clashes still trade`;
  else if (dF === null || dF <= 0) why = `clashing trades did worse on the unseen part but not before it (${fmt(first.opposed.avgR)} vs ${fmt(first.clear.avgR)}) — could be luck, clashes still trade`;
  else {
    active = true;
    why = `trades with a strategy firing the other way did worse on both parts (unseen ${fmt(unseen.opposed.avgR)} vs ${fmt(unseen.clear.avgR)}, before ${fmt(first.opposed.avgR)} vs ${fmt(first.clear.avgR)}) — the bot skips them`;
  }
  return { at: now, first, unseen, active, why };
}

/** The live wait text when the clash rule is on and another strategy's open lab trade points the other way. Pure. */
export function clashWait(t: { strategy: string; pair: string; side: 1 | -1; entryT: number }, open: readonly SideEntry[], barMs: number): string | null {
  const o = opposedBy(t, entryIndex(open.filter((x) => x.pair === t.pair)), barMs);
  return o ? `${o.strategy} fired the other way here — strategies disagree, it skips this one (clash rule)` : null;
}
