/**
 * v27.33 weekend prep (owner: "make it an automated system that all weekend max-extends on preparing for the next weeks";
 * "look at jakeschincariol's trader skill, see if there is anything we can use"). Heavy research the hourly lab has no
 * room for during the week, run while the desk's market is closed (forex) / at the weekend (coins), on every strategy the
 * bot trades or nearly trades. All GRADED / DISPLAY ONLY — nothing here switches a strategy on or sizes a trade.
 *
 * 1. Robustness (plateau) sweep: the same strategy, filter and exit with the stop × 0.75 / 1 / 1.25 and the target × 0.75 /
 *    1 / 1.25 (8 neighbours). A real edge sits on a plateau — its neighbours made money on the unseen 30% too; an edge
 *    that only exists at one exact stop / target is a fitted spike (`fragile`).
 * 2. Time machine (idea from Jake Schincariol's day-trader-skill `trader-timemachine`, MIT): replay each of its unseen trades
 *    10× on random paths rebuilt from the market's own candles of the unseen weeks (+ the 60 days before them) at the same
 *    hour of the day (a candle's
 *    open / high / low / close as ratios to the previous close, scaled to the entry; stop first when a candle touches
 *    both). That is what the trade's stop / target GEOMETRY makes on a market with that volatility and no timing skill.
 *    Real avg R minus replay avg R = what its timing adds. The replays pay no spread, so the comparison is conservative.
 *    Plus its break-even win rate 1 / (1 + R) and the skill's verdict wording (coin flip / leans / strongly).
 * 3. Next week: 4,000 bootstrapped weeks of the live set — each key fires Poisson(its unseen trades a week) times, R drawn
 *    from its own unseen trades — → expected trades, P(green week), median and 5th / 95th percentile in R and in % of the
 *    account at the bot's risk per trade (overlap between trades ignored: the real bot caps open risk, so it is a rough
 *    upper bound on the swings).
 */
import { signalsFor, simulate } from './engine';
import { applyExit, type ExitKind } from './exits';
import { allowFor, type FilterKind } from './filters';
import { seeded } from './luck';
import { styleOf, type Strategy } from './strategies';
import type { Bar, Signal, Trade } from './types';
import type { Ctx } from './ta';
import type { Series } from './lab';

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const PREP = {
  on: true,
  /** rebuild at most this often over the weekend (v27.38, owner: "train a lot this weekend": 8 → 4) */
  everyHours: 4,
  grid: [0.75, 1, 1.25],
  /** a neighbour counts when it has this many unseen trades */
  minN: 10,
  /** plateau share under this → fragile */
  fragileBelow: 0.5,
  /** time machine: replays per real trade, candle pool (days), hour-slot tolerance (bars), cap on bars a replay runs */
  replaysPerTrade: 10,
  poolDays: 60,
  slotTol: 1,
  maxReplayBars: 120,
  weeks: 4_000,
  seed: 19,
  /** rows studied a desk: live ones first, then the closest near misses (v27.38: 14 → 24) */
  maxRows: 24,
};

/** Pure: scale a signal's stop and target distances (from the signal close) by `ms` / `mt`. */
export function scaleSignal(sig: Signal | null, close: number, ms: number, mt: number): Signal | null {
  if (!sig) return null;
  const stop = close - (close - sig.stop) * ms;
  const target = sig.target === null ? null : close + (sig.target - close) * mt;
  if (sig.side === 1 ? stop >= close : stop <= close) return null;
  return { ...sig, stop, target };
}

export interface PlateauCell {
  ms: number;
  mt: number;
  n: number;
  avgR: number;
}
export interface Plateau {
  cells: PlateauCell[];
  /** share of the 8 neighbours (with enough trades) that made money on the unseen 30% */
  share: number | null;
  worstAvgR: number | null;
  fragile: boolean;
}

/** Pure: the plateau verdict from the grid (centre = ms 1, mt 1). */
export function plateauOf(cells: readonly PlateauCell[], minN = PREP.minN, fragileBelow = PREP.fragileBelow): Plateau {
  const nb = cells.filter((c) => !(c.ms === 1 && c.mt === 1) && c.n >= minN);
  const share = nb.length ? nb.filter((c) => c.avgR > 0).length / nb.length : null;
  const worst = nb.length ? Math.min(...nb.map((c) => c.avgR)) : null;
  return { cells: [...cells], share: share === null ? null : r3(share), worstAvgR: worst === null ? null : r3(worst), fragile: share !== null && share < fragileBelow };
}

export interface MachineResult {
  /** real unseen trades replayed and the replays run */
  trades: number;
  replays: number;
  targetFirst: number;
  stopFirst: number;
  neither: number;
  /** replay avg R (no costs) vs the real avg R of the same trades */
  replayAvgR: number;
  realAvgR: number;
  /** real − replay: what its timing adds over the bare stop / target geometry */
  edgeR: number;
  /** median target in R and the win rate that breaks even at it */
  targetR: number | null;
  breakEvenPct: number | null;
  verdict: string;
}

/** Pure: the skill's verdict wording, on the replays that hit a side. */
export function machineVerdict(targetFirst: number, stopFirst: number, targetR: number | null, total = 0): string {
  const hit = targetFirst + stopFirst;
  if (hit < 30 || !targetR) return 'too few replays reached the stop or the target to say';
  const share = targetFirst / hit;
  const need = 1 / (1 + targetR);
  const d = (share - need) * 100;
  const what = targetR > 0.95 && targetR < 1.05 ? 'Close to a coin flip' : 'Close to break-even';
  const open = total > 0 && 1 - hit / total > 0.4 ? `; ${Math.round((1 - hit / total) * 100)}% of replays hit neither within its hold (the price at the end decides those)` : '';
  if (Math.abs(d) < 5) return `${what}: target first in ${Math.round(share * 100)}% of the replays that hit a side (break-even ${Math.round(need * 100)}%)${open}`;
  return `${Math.abs(d) < 15 ? 'Leans' : 'Strongly'} toward the ${d > 0 ? 'target' : 'stop'}: ${Math.round(share * 100)}% target first vs ${Math.round(need * 100)}% to break even${open}`;
}

/**
 * Pure: the time machine on one market's candles for a set of finished trades. Candle pool = the candles in [`from`, `to`)
 * (a random-walk baseline of that period's volatility by hour of the day — a yardstick, not a forecast); a replay starts
 * at the trade's entry candle's slot of the day.
 */
export function timeMachine(bars: readonly Bar[], trades: readonly Trade[], barMin: number, from: number, asOf: number, o: { replays?: number; slotTol?: number; maxBars?: number; seed?: number } = {}): MachineResult | null {
  const replays = o.replays ?? PREP.replaysPerTrade;
  const tol = o.slotTol ?? PREP.slotTol;
  const maxBars = o.maxBars ?? PREP.maxReplayBars;
  const slots = Math.max(1, Math.round((24 * 60) / barMin));
  const slotOf = (t: number) => Math.floor((t % 86_400_000) / (barMin * 60_000)) % slots;
  const pool: Array<Array<[number, number, number, number]>> = Array.from({ length: slots }, () => []);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.t < from || b.t >= asOf) continue;
    const pc = bars[i - 1]!.c;
    if (!(pc > 0) || b.t - bars[i - 1]!.t > barMin * 60_000 * 3) continue; // no weekend gaps in the pool
    pool[slotOf(b.t)]!.push([b.o / pc, b.h / pc, b.l / pc, b.c / pc]);
  }
  if (pool.reduce((n, p) => n + p.length, 0) < slots * 10) return null;
  const rnd = seeded(o.seed ?? PREP.seed);
  const pick = (slot: number) => {
    for (let k = 0; k < 8; k++) {
      const s = (slot + Math.round((rnd() * 2 - 1) * tol) + slots) % slots;
      const p = pool[s]!;
      if (p.length) return p[Math.floor(rnd() * p.length)]!;
    }
    return null;
  };
  let tFirst = 0;
  let sFirst = 0;
  let neither = 0;
  let sumR = 0;
  let n = 0;
  const usable = trades.filter((t) => t.reason !== 'open' && Math.abs(t.entry - t.stop0) > 0);
  const rTargets: number[] = [];
  for (const t of usable) {
    const risk = Math.abs(t.entry - t.stop0);
    const tgt = t.target0 ?? t.target;
    const tr = tgt === null || tgt === undefined ? null : Math.abs(tgt - t.entry) / risk;
    if (tr !== null) rTargets.push(tr);
    const len = Math.max(1, Math.min(maxBars, Math.max(t.bars, 1) * 2));
    for (let k = 0; k < replays; k++) {
      let px = t.entry;
      let slot = slotOf(t.entryT);
      let out: number | null = null;
      for (let b = 0; b < len; b++) {
        const c = pick(slot);
        slot = (slot + 1) % slots;
        if (!c) break;
        const hi = px * c[1];
        const lo = px * c[2];
        const hitStop = t.side === 1 ? lo <= t.stop0 : hi >= t.stop0;
        const hitTgt = tgt !== null && tgt !== undefined && (t.side === 1 ? hi >= tgt : lo <= tgt);
        if (hitStop) {
          out = -1;
          sFirst++;
          break;
        }
        if (hitTgt) {
          out = tr!;
          tFirst++;
          break;
        }
        px *= c[3];
      }
      if (out === null) {
        neither++;
        out = (t.side * (px - t.entry)) / risk;
      }
      sumR += out;
      n++;
    }
  }
  if (!n) return null;
  rTargets.sort((a, b) => a - b);
  const targetR = rTargets.length ? r3(rTargets[Math.floor(rTargets.length / 2)]!) : null;
  const realAvgR = usable.reduce((s, t) => s + t.r, 0) / usable.length;
  const replayAvgR = sumR / n;
  return {
    trades: usable.length,
    replays: n,
    targetFirst: r3(tFirst / n),
    stopFirst: r3(sFirst / n),
    neither: r3(neither / n),
    replayAvgR: r3(replayAvgR),
    realAvgR: r3(realAvgR),
    edgeR: r3(realAvgR - replayAvgR),
    targetR,
    breakEvenPct: targetR ? Math.round(100 / (1 + targetR)) : null,
    verdict: machineVerdict(tFirst, sFirst, targetR, n),
  };
}

export interface WeekForecast {
  keys: number;
  /** expected trades a week, P(green week), R quantiles, and the same in % of the account at `riskPct` a trade */
  tradesPerWeek: number;
  pGreen: number;
  medianR: number;
  p5R: number;
  p95R: number;
  riskPct: number;
  medianPct: number;
  p5Pct: number;
  p95Pct: number;
}

/** Pure: bootstrapped weeks of the live set (each key: Poisson(rate) trades, R drawn from its own unseen trades). */
export function weekForecast(sets: ReadonlyArray<{ perWeek: number; rs: readonly number[] }>, riskPct: number, weeks = PREP.weeks, seed = PREP.seed): WeekForecast | null {
  const use = sets.filter((s) => s.rs.length && s.perWeek > 0);
  if (!use.length) return null;
  const rnd = seeded(seed);
  const poisson = (lam: number) => {
    const L = Math.exp(-lam);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rnd();
    } while (p > L && k < 200);
    return k - 1;
  };
  const out: number[] = [];
  let green = 0;
  for (let w = 0; w < weeks; w++) {
    let s = 0;
    for (const x of use) {
      const k = poisson(x.perWeek);
      for (let j = 0; j < k; j++) s += x.rs[Math.floor(rnd() * x.rs.length)]!;
    }
    if (s > 0) green++;
    out.push(s);
  }
  out.sort((a, b) => a - b);
  const q = (p: number) => out[Math.min(out.length - 1, Math.floor(p * out.length))]!;
  const pct = (r: number) => Math.round(r * riskPct * 10) / 10;
  return {
    keys: use.length,
    tradesPerWeek: Math.round(use.reduce((n, x) => n + x.perWeek, 0) * 10) / 10,
    pGreen: r3(green / weeks),
    medianR: r3(q(0.5)),
    p5R: r3(q(0.05)),
    p95R: r3(q(0.95)),
    riskPct,
    medianPct: pct(q(0.5)),
    p5Pct: pct(q(0.05)),
    p95Pct: pct(q(0.95)),
  };
}

export interface PrepRow {
  key: string;
  name: string;
  /** live = trades now (whole row), cell = trades on these markets only (proven there), near = a near miss */
  kind: 'live' | 'cell' | 'near';
  pairs: string[];
  plateau: Plateau;
  machine: MachineResult | null;
  /** its unseen record on the studied markets (centre of the grid) */
  unseenN: number;
  unseenAvgR: number;
  perWeek: number;
  /** its unseen R list (for the forecast; not stored) */
  unseenRs?: number[];
}
export interface PrepReport {
  at: number;
  oosFrom: number;
  ms: number;
  rows: PrepRow[];
  forecast: WeekForecast | null;
  notes: string[];
}

/** what a studied row needs from lab.ts Row */
export interface PrepTarget {
  s: Strategy;
  key: string;
  name: string;
  tf: string;
  filter: FilterKind;
  exit: ExitKind;
  kind: PrepRow['kind'];
  /** markets to study (empty = every market of the series) */
  pairs: string[];
}

/** The heavy part: sweep + time machine for one row on its series. Yields to the event loop between simulations. */
export async function studyRow(x: PrepTarget, series: readonly Series[], oosFrom: number, to: number): Promise<PrepRow> {
  const ss = series.filter((se) => se.tf === x.tf && (!x.pairs.length || x.pairs.includes(se.inst.id)));
  const style = styleOf(x.s);
  const base: Array<{ se: Series; sigs: Array<Signal | null>; allow: ReturnType<typeof allowFor> }> = ss.map((se) => ({ se, sigs: signalsFor(se.ctx, x.s).map((sg, i) => applyExit(sg, x.exit, se.ctx, i)), allow: allowFor(x.filter, se.env, style) }));
  const cells: PlateauCell[] = [];
  let centre: Trade[] = [];
  for (const ms of PREP.grid) {
    for (const mt of PREP.grid) {
      const trades: Trade[] = [];
      for (const b of base) {
        const c: Ctx = b.se.ctx;
        const sigs = ms === 1 && mt === 1 ? b.sigs : b.sigs.map((sg, i) => scaleSignal(sg, c.close[i]!, ms, mt));
        for (const t of simulate(b.se.inst, b.se.tf, c, x.s.id, sigs, b.allow)) trades.push(t);
        await yieldNow();
      }
      const unseen = trades.filter((t) => t.reason !== 'open' && t.entryT >= oosFrom);
      cells.push({ ms, mt, n: unseen.length, avgR: unseen.length ? r3(unseen.reduce((s, t) => s + t.r, 0) / unseen.length) : 0 });
      if (ms === 1 && mt === 1) centre = unseen;
    }
  }
  // time machine per market, pooled
  const results: MachineResult[] = [];
  for (const b of base) {
    const tr = centre.filter((t) => t.pair === b.se.inst.id);
    if (!tr.length) continue;
    const m = timeMachine(b.se.ctx.bars, tr, b.se.ctx.barMin, oosFrom - PREP.poolDays * 86_400_000, to);
    if (m) results.push(m);
  }
  const machine = poolMachines(results);
  const weeks = Math.max(1, (to - oosFrom) / (7 * 86_400_000));
  return {
    key: x.key,
    name: x.name,
    kind: x.kind,
    pairs: x.pairs,
    plateau: plateauOf(cells),
    machine,
    unseenN: centre.length,
    unseenAvgR: centre.length ? r3(centre.reduce((s, t) => s + t.r, 0) / centre.length) : 0,
    perWeek: r3(centre.length / weeks),
    unseenRs: centre.map((t) => t.r),
  };
}

/** Pure: several markets' time-machine results weighted by their replays. */
export function poolMachines(ms: readonly MachineResult[]): MachineResult | null {
  if (!ms.length) return null;
  const N = ms.reduce((n, m) => n + m.replays, 0);
  const T = ms.reduce((n, m) => n + m.trades, 0);
  const w = (f: (m: MachineResult) => number, by: (m: MachineResult) => number) => ms.reduce((s, m) => s + f(m) * by(m), 0);
  const tf = w((m) => m.targetFirst, (m) => m.replays) / N;
  const sf = w((m) => m.stopFirst, (m) => m.replays) / N;
  const rs = ms.map((m) => m.targetR).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const targetR = rs.length ? rs[Math.floor(rs.length / 2)]! : null;
  const replayAvgR = w((m) => m.replayAvgR, (m) => m.replays) / N;
  const realAvgR = w((m) => m.realAvgR, (m) => m.trades) / T;
  return {
    trades: T,
    replays: N,
    targetFirst: r3(tf),
    stopFirst: r3(sf),
    neither: r3(w((m) => m.neither, (m) => m.replays) / N),
    replayAvgR: r3(replayAvgR),
    realAvgR: r3(realAvgR),
    edgeR: r3(realAvgR - replayAvgR),
    targetR,
    breakEvenPct: targetR ? Math.round(100 / (1 + targetR)) : null,
    verdict: machineVerdict(Math.round(tf * N), Math.round(sf * N), targetR, N),
  };
}

/** Pure: plain-words notes from the studied rows. */
export function prepNotes(rows: readonly PrepRow[], f: WeekForecast | null): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const where = r.kind === 'cell' ? ` on ${r.pairs.join(', ')}` : '';
    if (r.kind !== 'near' && r.plateau.fragile) out.push(`${r.name}${where} is FRAGILE: only ${Math.round((r.plateau.share ?? 0) * 100)}% of the nearby stop / target settings made money on unseen data (worst ${r.plateau.worstAvgR}R) — its edge may be fitted to one exact setting.`);
    else if (r.kind !== 'near' && r.plateau.share !== null) out.push(`${r.name}${where} holds up: ${Math.round(r.plateau.share * 100)}% of the nearby stop / target settings made money too.`);
    if (r.machine && r.kind !== 'near') out.push(`${r.name}${where}: on random price paths with the same stop and target it would make ${r.machine.replayAvgR}R a trade; for real it made ${r.machine.realAvgR}R — its timing adds ${r.machine.edgeR > 0 ? '+' : ''}${r.machine.edgeR}R a trade.`);
    if (r.kind === 'near' && r.plateau.share !== null && r.plateau.share >= 0.75 && r.machine && r.machine.edgeR > 0.1) out.push(`${r.name} (not live yet) looks solid in the weekend study: ${Math.round(r.plateau.share * 100)}% of nearby settings positive, timing adds +${r.machine.edgeR}R — it still has to pass the strict test.`);
  }
  if (f) out.push(`Next week, if it trades like the unseen data: about ${f.tradesPerWeek} trades, ${Math.round(f.pGreen * 100)}% chance of a green week, typical week ${f.medianPct > 0 ? '+' : ''}${f.medianPct}% of the account, a bad week (1 in 20) ${f.p5Pct}%, a good one ${f.p95Pct > 0 ? '+' : ''}${f.p95Pct}% at ${f.riskPct}% risk a trade.`);
  return out;
}
