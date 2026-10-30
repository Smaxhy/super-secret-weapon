/**
 * v28 replay (owner: "look into FX Replay … I want the bot to be better and faster"): FX Replay is a manual chart-replay
 * website with no public API, so its idea is built in instead — one market, one chart, a stretch of history, and every
 * picked strategy's trades on it exactly as the lab tests them: the same candles (incl. the Dukascopy / Databento history
 * stitched in front of Yahoo's), the same filter / exit / way in each row trades with, the same costs, and the row's
 * skipped sessions / markets. The dashboard (FxReplay.tsx) plays the candles forward and reveals each trade when it
 * happens. Read-only: nothing here touches a trade, a pick or the lab's records.
 */
import { DEFAULT_SIM, signalsFor, simulate } from './engine';
import { applyExit, type ExitKind } from './exits';
import { allowFor, type FilterKind } from './filters';
import type { EntryKind } from './entries';
import { inSkipped, makeSeries, bigChart, attachHmm, type MarketBook, type Row, type Series } from './lab';
import { toDaily, withEnd } from './mtf';
import { STRATEGIES, runsOn, styleOf } from './strategies';
import { to4h } from './ta';
import { type Bar, type Instrument, type Timeframe, type Trade } from './types';

const HOUR = 3_600_000;
export const REPLAY = {
  /** candles handed to the page at most (the window is cut to this, newest kept) */
  maxBars: 3_000,
  /** at most this many strategies in one replay */
  maxPicks: 8,
  /** a built replay is reused this long (same market / chart / window / picks / lab report) */
  cacheMs: 5 * 60_000,
};

export interface ReplayPick {
  id: string;
  name: string;
  tf: Timeframe;
  filter: FilterKind;
  exit: ExitKind;
  entry: EntryKind;
  /** v28.6: its profit lock when not the tight one */
  lock?: 'loose' | 'off' | 'step';
  verdict: Row['verdict'];
  /** the bot trades it now */
  live: boolean;
  skip?: Row['skip'];
  /** unseen record (pooled over markets) for the picker */
  outN: number;
  outAvgR: number;
  /** in this replay */
  on?: boolean;
}

export interface ReplayTrade {
  strategy: string;
  side: 1 | -1;
  entryT: number;
  entry: number;
  exitT: number;
  exit: number;
  stop0: number;
  target: number | null;
  r: number;
  reason: Trade['reason'];
}

export interface ReplayResult {
  pair: string;
  tf: Timeframe;
  from: number;
  to: number;
  /** the lab's 70/30 line: trades entered after it are the unseen part the verdicts were graded on */
  oosFrom: number | null;
  /** [t,o,h,l,c] in ms */
  bars: number[][];
  trades: ReplayTrade[];
  picks: ReplayPick[];
  note?: string;
}

/** The rows of one chart a replay can run (random dropped), the bot's live ones first, then by unseen record. Pure. */
export function replayPicks(rows: ReadonlyArray<Row>, tf: Timeframe, live: ReadonlySet<string>): ReplayPick[] {
  return rows
    .filter((r) => r.tf === tf && r.id !== 'random')
    .map((r) => ({ id: r.id, name: r.name, tf: r.tf, filter: r.filter, exit: r.exit, entry: r.entry ?? 'market', ...(r.lock ? { lock: r.lock } : {}), verdict: r.verdict, live: live.has(`${r.id}:${r.tf}`), ...(r.skip ? { skip: r.skip } : {}), outN: r.outSample.n, outAvgR: r.outSample.avgR }))
    .sort((a, b) => Number(b.live) - Number(a.live) || (a.verdict === b.verdict ? 0 : a.verdict === 'edge' ? -1 : b.verdict === 'edge' ? 1 : a.verdict === 'maybe' ? -1 : 1) || b.outAvgR - a.outAvgR);
}

/** One market's chart as the lab builds it (bigger charts from the hourly bars). `fast15` = the 15-minute bars. Pure. */
export function replaySeries(inst: Instrument, tf: Timeframe, h1: Bar[], book: MarketBook, fast15?: Bar[]): Series | null {
  if (tf === '1h' || tf === '4h') {
    if (h1.length < 400) return null;
    const h4 = withEnd(to4h(h1), 4 * HOUR);
    const bars = tf === '1h' ? h1 : h4.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, ...(v !== undefined ? { v } : {}) }));
    return makeSeries(inst, tf, bars, book, tf === '1h' ? bigChart(h4) : null, bigChart(toDaily(h1)));
  }
  if (tf === '15m' && fast15 && fast15.length >= 400) return makeSeries(inst, tf, fast15, book, h1.length ? bigChart(withEnd(h1, HOUR)) : null, h1.length ? bigChart(withEnd(to4h(h1), 4 * HOUR)) : null);
  return null;
}

/** Each pick's trades on the series that ENTERED inside [from, to], as the lab simulates them. Pure. */
export function replayTrades(se: Series, picks: ReadonlyArray<ReplayPick>, from: number, to: number, oosFrom: number | null): ReplayTrade[] {
  if (oosFrom !== null) attachHmm(se, oosFrom);
  const out: ReplayTrade[] = [];
  for (const p of picks.slice(0, REPLAY.maxPicks)) {
    const s = STRATEGIES.find((x) => x.id === p.id);
    if (!s || !runsOn(s, se.tf, se.inst.id)) continue;
    const sigs = signalsFor(se.ctx, s);
    const mapped = p.exit === 'designed' ? sigs : sigs.map((sg, i) => applyExit(sg, p.exit, se.ctx, i));
    const ts = simulate(se.inst, se.tf, se.ctx, s.id, mapped, allowFor(p.filter, se.env, styleOf(s)), { ...DEFAULT_SIM, entry: p.entry, lockKind: p.lock ?? 'tight' });
    for (const t of ts) {
      if (t.entryT < from || t.entryT > to || inSkipped(p.skip, t)) continue;
      out.push({ strategy: t.strategy, side: t.side, entryT: t.entryT, entry: t.entry, exitT: t.exitT, exit: t.exit, stop0: t.stop0, target: t.target0 ?? t.target, r: Math.round(t.r * 1000) / 1000, reason: t.reason });
    }
  }
  return out.sort((a, b) => a.entryT - b.entryT);
}

/** The window's candles as [t,o,h,l,c], newest `maxBars` kept. Pure. */
export function windowBars(bars: readonly Bar[], from: number, to: number, max = REPLAY.maxBars): number[][] {
  const w = bars.filter((b) => b.t >= from && b.t <= to);
  return w.slice(-max).map((b) => [b.t, b.o, b.h, b.l, b.c]);
}

/** Build a replay: one chart, a window, picked strategies. Pure apart from the caller's inputs. */
export function buildReplay(o: { inst: Instrument; tf: Timeframe; h1: Bar[]; fast15?: Bar[]; book: MarketBook; rows: ReadonlyArray<Row>; live: ReadonlySet<string>; pick: ReadonlyArray<string> | null; from: number; to: number; oosFrom: number | null }): ReplayResult {
  const picksAll = replayPicks(o.rows, o.tf, o.live);
  const wanted = o.pick?.length ? picksAll.filter((p) => o.pick!.includes(p.id)) : picksAll.filter((p) => p.live).length ? picksAll.filter((p) => p.live) : picksAll.filter((p) => p.verdict !== 'no').slice(0, 3);
  const se = replaySeries(o.inst, o.tf, o.h1, o.book, o.fast15);
  const base = { pair: o.inst.id, tf: o.tf, from: o.from, to: o.to, oosFrom: o.oosFrom, picks: picksAll };
  if (!se) return { ...base, bars: [], trades: [], note: `not enough ${o.tf} candles on ${o.inst.id} yet` };
  const bars = windowBars(se.ctx.bars, o.from, o.to);
  if (!bars.length) return { ...base, bars, trades: [], note: 'no candles in that stretch (market closed or before the history starts)' };
  const trades = replayTrades(se, wanted, bars[0]![0]!, o.to, o.oosFrom);
  return { ...base, bars, trades, picks: picksAll.map((p) => ({ ...p, on: wanted.includes(p) })), ...(wanted.length ? {} : { note: 'no strategy picked' }) };
}
