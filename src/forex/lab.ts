/**
 * Forex lab (v12 → v15): every hour — refresh the candles, run EVERY strategy on every instrument on 1h and 4h bars,
 * raw and with each trade filter (currency strength, bigger-chart trend, market mood, regime, all three), then with
 * each exit variant (break-even, half off at +1R, closer target, runner, shorter time, v15: bigger target and the
 * trailing take-profits) — both picked on the first 70% only — train the signal judge (meta-labeling) on the first
 * 70% and grade it on the rest, and publish (a) the backtest over the full history with an in-sample /
 * out-of-sample split and weekly results at several risk levels, (b) the PAPER results = trades opened after the lab
 * first started (a true forward test), (c) the whole-bot backtest on the unseen last 30% (strategies AND filters
 * picked on the first 70% only), (d) the live market read: currency strength, market mood, bigger-chart trends, and
 * (e) what prices did after past shock candles. v15: the per-chart routine (`evaluateTf`) and the market read
 * (`book`) are shared with the 15-minute / 1-minute lab (`fast.ts`). Redis `fx:report`, `fx:paper:since`,
 * `fx:portfolio`. Nothing here places a real order.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { refreshInstrument, refreshSeries, loadBars, type FeedStatus } from './data';
import { DK_META, installSpreadProfiles, loadDk, refreshDukascopy, stitchHistory, type DkMeta } from './dukascopy';
import { hasSpreadProfile } from './spreads';
import { carrySeries, cotSeries, loadMacro, macroNow, refreshMacro, type MacroData } from './macro';
import { RISK_MODES, newSyncReport, type LabOpenTrade, type Practice, type SyncReport } from './practice';
import type { ForexCalendar } from './calendar';
import type { ForexHeadlines } from './headlines';
import { equityCurve, rStats, signalsFor, simulate, type RiskResult, type RStats } from './engine';
import { STRATEGIES, runsOn, styleOf, type Family, type Strategy, type Style } from './strategies';
import { buildCtx, to4h, type Ctx } from './ta';
import { drawingsFor, type Drawings } from './drawings';
import { INSTRUMENTS, MOOD_SYMBOLS, STRENGTH_PAIRS, TF_MIN, type Bar, type Instrument, type Signal, type Timeframe, type Trade } from './types';
import { buildStrength, gapSeries, scoreAt, strengthNow, type StrengthBook, type StrengthNow } from './strength';
import { alignTrend, decisionTimes, toDaily, trendSeries, withEnd, type SpanBar } from './mtf';
import { buildMood, moodNow, moodSeries, riskOfLong, type MoodBook, type MoodNow } from './mood';
import { FILTERS, FILTER_LABEL, allowFor, blockReason, chooseFilter, chooseVariant, preferVariant, type FilterEnv, type FilterKind } from './filters';
import { SIZING, simulatePortfolio, stratFactorFromStats, stratFactorFromVerdict, volFactor, walkForward, type PortfolioResult, type PTrade, type WalkForward, type WTrade } from './portfolio';
import { newsStudy, type NewsStudy } from './news-study';
import { EXITS, EXIT_LABEL, OWNER_EXITS, applyExit, type ExitKind } from './exits';
import { judgeFeatures, judgeProb, trainJudge, type JudgeModel, type JudgeReport, type JudgeRow } from './judge';
import { alignAt, mtdSeries, pairRanks, strengthRanks, z24Series, type TimeSeries } from './intermarket';
import { extraVotes, gradeSniper, SNIPER, type SniperReport } from './sniper';
import { heatmapFor, type Heatmap } from './heatmap';
import { agreeCount, boostFor, confirmations, CONVICTION, gradeConviction, judgeCuts, maxConfirmations, tierOf, type ConvictionReport } from './conviction';

const log = moduleLogger('forex-lab');

export const FX_CONFIG = {
  timeframes: ['1h', '4h'] as Timeframe[],
  /** the bot account always trades these (published evidence) on top of whatever the lab marks edge / maybe */
  botAlways: ['tsmom', 'tsmom_long', 'local_hours', 'fix_flow'],
  riskLevelsPct: [0.5, 1, 2, 5],
  /** leverage cap per trade (retail brokers 30–50×; on-chain perps allow more — we don't) */
  maxLeverage: 50,
  oosFraction: 0.3,
  refreshMinutes: 60,
  minOosTrades: 30,
  /** whole-bot backtest: base risk levels tried, and what a strategy needs on the first 70% to be picked */
  portfolioRiskPct: [0.5, 1, 2, 3, 5],
  pick: { minN: 40, minAvgR: 0.05, minPf: 1.15 },
  /** walk-forward: re-pick every month from the trades closed in the previous N months */
  walkForward: { lookbackMonths: 6, minN: 15, minAvgR: 0.05, minPf: 1.15 },
  /** owner (v15 "more pips", v15.1 "a trailing SL for safety"): use a trailing stop-loss, else a trailing take-profit,
   * wherever it tests as well as the best exit */
  preferTrailing: true,
};

export interface VariantRow {
  filter: FilterKind;
  inN: number;
  inAvgR: number;
  outN: number;
  outAvgR: number;
  outPf: number | null;
  allN: number;
}

export interface ExitVariantRow extends Omit<VariantRow, 'filter'> {
  exit: ExitKind;
}

export interface Row {
  id: string;
  name: string;
  family: Family;
  desc: string;
  tf: Timeframe;
  /** v13: the filter it trades with (picked on the first 70% only) */
  filter: FilterKind;
  /** raw and every filter, side by side (exits as designed) */
  variants: VariantRow[];
  /** v14: the exit it trades with (picked on the first 70% only, under its filter) */
  exit: ExitKind;
  exitVariants: ExitVariantRow[];
  all: RStats;
  inSample: RStats;
  outSample: RStats;
  tradesPerWeek: number;
  risk: RiskResult[];
  pairs: Array<{ pair: string } & RStats>;
  /** edge / maybe / no */
  verdict: 'edge' | 'maybe' | 'no';
  why: string;
}

export interface PaperRow {
  id: string;
  name: string;
  tf: Timeframe;
  stats: RStats;
  risk1: RiskResult;
  open: number;
}

export interface MarketNow {
  id: string;
  label: string;
  price: number;
  t: number;
  change24hPct: number;
  /** last 72 hourly closes for a sparkline */
  closes: number[];
  trend: 'up' | 'down' | 'flat';
  rsi: number;
  /** average hourly range in pips */
  atrPips: number;
  /** strategies whose rule fired on the last closed bar, whether their filter lets the bot take it, and (v15) whether
   * the bot trades that strategy on that chart */
  firing: Array<{ id: string; name: string; tf: Timeframe; side: 1 | -1; allowed: boolean; why: string | null; chosen?: boolean }>;
  openPaper: number;
  /** last 150 hourly bars [t,o,h,l,c] for the chart */
  bars: number[][];
  drawings: Drawings;
  /** v16: where orders likely sit near the price + what the quant engines read now */
  heat?: Heatmap;
  /** v13: trend on the 1h / 4h / daily chart (+1 up, −1 down, 0 none) */
  mtf: { h1: number; h4: number; d1: number };
  /** v13: strength of its two currencies and the gap (base − quote) */
  strength: { base: string; quote: string; baseScore: number | null; quoteScore: number | null; gap: number | null };
  /** v13: how risk-on buying this market is (+ risk-on, − safe haven) */
  risk: number;
}

export interface FilterSummary {
  filter: FilterKind;
  label: string;
  /** strategies that picked it (on the first 70%) */
  chosenBy: number;
  /** strategies with enough trades to compare */
  compared: number;
  /** average change in R per trade vs no filter: first 70% / unseen 30% */
  inDeltaR: number;
  outDeltaR: number;
  /** % of compared strategies it improved on the unseen 30% */
  outBetterPct: number;
  /** % of the trades it keeps */
  keptPct: number;
  /** random entries + this filter: does the filter alone add anything? */
  random: { inAvgR: number; outAvgR: number; outN: number };
}

export interface ExitSummary {
  exit: ExitKind;
  label: string;
  chosenBy: number;
  compared: number;
  inDeltaR: number;
  outDeltaR: number;
  outBetterPct: number;
}

export interface PortfolioReport {
  from: number;
  to: number;
  picked: Array<{ id: string; name: string; tf: Timeframe; filter: FilterKind; exit: ExitKind; inAvgR: number; inN: number; unseenN: number }>;
  oldPicked: number;
  /** the upgraded bot at several base risk levels */
  levels: PortfolioResult[];
  /** the bot as it was before v13 (no filters, flat 1% risk, no currency cap) on the same unseen weeks */
  old: PortfolioResult;
  /** v14: the upgraded bot at 1% with the signal judge's gate (judge trained on the first 70% only) */
  judged: PortfolioResult | null;
  /** v14: re-picking strategies every month from the months before (raw rules), over the whole history */
  walkForward: WalkForward | null;
  /** v16: the upgraded bot at 1% with the sniper trades at the sniper size (null = sniper not proven) */
  sniped?: PortfolioResult | null;
  /** v15.2: the upgraded bot at 1% with bigger size + leverage on the 'sure' trades (null = conviction not proven) */
  convicted?: PortfolioResult | null;
  note: string;
}

export interface FxReport {
  at: number;
  durationMs: number;
  feed: FeedStatus[];
  from: number | null;
  to: number | null;
  oosFrom: number | null;
  rows: Row[];
  markets: MarketNow[];
  paper: { since: number; rows: PaperRow[]; open: Trade[]; recent: Trade[] };
  note: string;
  strength?: StrengthNow;
  mood?: MoodNow;
  filters?: FilterSummary[];
  portfolio?: PortfolioReport | null;
  news?: NewsStudy | null;
  exits?: ExitSummary[];
  judge?: JudgeReport | null;
  /** v15.2: bigger size when more sure — the tiers and whether they proved themselves */
  conviction?: ConvictionReport | null;
  /** v16: the sniper vote level and whether it proved itself */
  sniper?: SniperReport | null;
  /** v16: extra data feeds (Dukascopy history + spreads, CFTC positioning, policy rates) */
  extFeeds?: { dukascopy: DkMeta | null; spreadProfiles: string[]; macro: ReturnType<typeof macroNow>; historyFrom: number };
}

export const FX_REPORT = 'fx:report';
export const FX_PAPER_SINCE = 'fx:paper:since';
export const FX_PORTFOLIO = 'fx:portfolio';
/** last hour's filter + exit per strategy × timeframe (keeps near-ties from flipping) */
export const FX_FILTERS_CHOSEN = 'fx:filters:chosen';
/** the signal judge (trees + threshold), for the live bot */
export const FX_JUDGE = 'fx:judge';
/** v15: the bot's check timeline */
export const FX_BOT_RUNS = 'fx:bot:runs';
/** v15.2: conviction tiers (hourly charts) */
export const FX_CONVICTION = 'fx:conviction';
/** v16: sniper grade */
export const FX_SNIPER = 'fx:sniper';

const yieldNow = () => new Promise((r) => setImmediate(r));
const HOUR = 3_600_000;

/** Pure: judge one strategy × timeframe against the random yardstick. */
export function verdictFor(row: Pick<Row, 'inSample' | 'outSample' | 'all'>, randomAvgR: number | null): { verdict: Row['verdict']; why: string } {
  const o = row.outSample;
  const i = row.inSample;
  const beatsRandom = randomAvgR === null || row.all.avgR >= randomAvgR + 0.05;
  if (o.n < FX_CONFIG.minOosTrades) return { verdict: 'no', why: `only ${o.n} trades in the unseen last ${Math.round(FX_CONFIG.oosFraction * 100)}% (needs ${FX_CONFIG.minOosTrades})` };
  if (o.avgR > 0 && i.avgR > 0 && (o.pf ?? 99) >= 1.2 && beatsRandom) return { verdict: 'edge', why: `positive before AND after the split (out of sample ${o.avgR}R a trade, PF ${o.pf ?? '∞'}) and beats random` };
  if (o.avgR > 0 && (row.all.pf ?? 99) >= 1.1) return { verdict: 'maybe', why: `positive on unseen data (${o.avgR}R) but ${i.avgR <= 0 ? 'lost in the first part' : (o.pf ?? 99) < 1.2 ? 'too thin (PF under 1.2)' : 'not clearly better than random'}` };
  return { verdict: 'no', why: o.avgR <= 0 ? `loses on unseen data (${o.avgR}R a trade)` : 'too weak overall' };
}

/** Pure: does a strategy's first-70% record earn it a place in the bot (the honest whole-bot test)? */
export const pickedOnInSample = (s: RStats) => s.n >= FX_CONFIG.pick.minN && s.avgR >= FX_CONFIG.pick.minAvgR && (s.pf ?? 99) >= FX_CONFIG.pick.minPf;

/** Pure: how each filter did across all strategies, and on random entries. */
export function summarizeFilters(rows: ReadonlyArray<Pick<Row, 'id' | 'filter' | 'variants'>>): FilterSummary[] {
  const out: FilterSummary[] = [];
  for (const f of FILTERS) {
    if (f === 'none') continue;
    let compared = 0;
    let inD = 0;
    let outD = 0;
    let better = 0;
    let kept = 0;
    let keptN = 0;
    let outCompared = 0;
    for (const r of rows) {
      if (r.id === 'random') continue;
      const raw = r.variants.find((v) => v.filter === 'none');
      const v = r.variants.find((x) => x.filter === f);
      if (!raw || !v) continue;
      if (raw.allN > 0) {
        kept += v.allN / raw.allN;
        keptN++;
      }
      if (raw.inN < 30 || v.inN < 30) continue;
      compared++;
      inD += v.inAvgR - raw.inAvgR;
      if (raw.outN >= 15 && v.outN >= 15) {
        outCompared++;
        outD += v.outAvgR - raw.outAvgR;
        if (v.outAvgR > raw.outAvgR) better++;
      }
    }
    const rnd = rows.find((r) => r.id === 'random')?.variants.find((v) => v.filter === f);
    const r2 = (x: number) => Math.round(x * 100) / 100;
    out.push({
      filter: f,
      label: FILTER_LABEL[f],
      chosenBy: rows.filter((r) => r.id !== 'random' && r.filter === f).length,
      compared,
      inDeltaR: compared ? r2(inD / compared) : 0,
      outDeltaR: outCompared ? r2(outD / outCompared) : 0,
      outBetterPct: outCompared ? Math.round((better / outCompared) * 100) : 0,
      keptPct: keptN ? Math.round((kept / keptN) * 100) : 0,
      random: { inAvgR: rnd?.inAvgR ?? 0, outAvgR: rnd?.outAvgR ?? 0, outN: rnd?.outN ?? 0 },
    });
  }
  return out;
}

/** Pure: how each exit did across all strategies (each under its own chosen filter). */
export function summarizeExits(rows: ReadonlyArray<Pick<Row, 'id' | 'exit' | 'exitVariants'>>): ExitSummary[] {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return EXITS.filter((e) => e !== 'designed').map((e) => {
    let compared = 0;
    let inD = 0;
    let outD = 0;
    let outN = 0;
    let better = 0;
    for (const r of rows) {
      if (r.id === 'random') continue;
      const base = r.exitVariants.find((v) => v.exit === 'designed');
      const v = r.exitVariants.find((x) => x.exit === e);
      if (!base || !v || base.inN < 30 || v.inN < 30) continue;
      compared++;
      inD += v.inAvgR - base.inAvgR;
      if (base.outN >= 15 && v.outN >= 15) {
        outN++;
        outD += v.outAvgR - base.outAvgR;
        if (v.outAvgR > base.outAvgR) better++;
      }
    }
    return { exit: e, label: EXIT_LABEL[e], chosenBy: rows.filter((r) => r.id !== 'random' && r.exit === e).length, compared, inDeltaR: compared ? r2(inD / compared) : 0, outDeltaR: outN ? r2(outD / outN) : 0, outBetterPct: outN ? Math.round((better / outN) * 100) : 0 };
  });
}

/**
 * When the forward test (paper) started. v17: a Redis error throws (the run is skipped) instead of looking like "never
 * set" and restarting the paper clock; a missing value is set only if still missing (`NX`).
 */
export async function paperSince(redis: Pick<Redis, 'get' | 'set'>, key: string, now: number): Promise<number> {
  const raw = await redis.get(key);
  const v = Number(raw);
  if (raw !== null && Number.isFinite(v) && v > 0) return v;
  await redis.set(key, String(now), 'NX');
  const again = Number(await redis.get(key));
  return Number.isFinite(again) && again > 0 ? again : now;
}

/**
 * closed trades → all / first 70% / unseen 30% stats. v17 purge: the first 70% only holds trades that were FINISHED
 * before the boundary (a trade opened before it and closed after would carry unseen prices into the pick); the unseen
 * part holds trades opened after it. Trades straddling the boundary count in `all` only.
 */
export function statsOf(trades: readonly Trade[], oosFrom: number): Split {
  const done = trades.filter((t) => t.reason !== 'open');
  return { all: rStats(done), inSample: rStats(done.filter((t) => t.exitT < oosFrom)), outSample: rStats(done.filter((t) => t.entryT >= oosFrom)) };
}
type Split = { all: RStats; inSample: RStats; outSample: RStats };

/** index of the bar opening at t (−1 if none) */
export function indexOfT(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = bars[mid]!.t;
    if (v === t) return mid;
    if (v < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The bar whose close made a trade: the one before its entry bar. A trade filled at the last close (v15: its entry bar
 * hasn't opened in the data yet) → the last bar. −1 if unknown. Pure.
 */
export function signalIndex(bars: readonly Bar[], entryT: number, barMin: number): number {
  const ei = indexOfT(bars, entryT);
  if (ei >= 1) return ei - 1;
  const n = bars.length;
  return n && entryT === bars[n - 1]!.t + barMin * 60_000 ? n - 1 : -1;
}

/** 7 significant digits are plenty for a price (keeps the report small). */
const px7 = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(7)) : x);
/** A trade as the dashboard needs it. */
export function slimTrade(t: Trade): Trade {
  return { strategy: t.strategy, tf: t.tf, pair: t.pair, side: t.side, entryT: t.entryT, ...(t.keyT !== undefined && t.keyT !== t.entryT ? { keyT: t.keyT } : {}), exitT: t.exitT, entry: px7(t.entry), exit: px7(t.exit), r: Math.round(t.r * 100) / 100, stopPct: Math.round(t.stopPct * 1000) / 1000, reason: t.reason, bars: t.bars, stop: px7(t.stop), stop0: px7(t.stop0), target: t.target === null ? null : px7(t.target), ...(t.scaled ? { scaled: true } : {}), ...(t.tpHit ? { tpHit: true } : {}) };
}

/** A trade's identity (the bot's position ref): the signal bar's close, so a missing bar after it can't rename it. */
export const tradeKey = (t: { strategy: string; tf: string; pair: string; entryT: number; keyT?: number }) => `${t.strategy}:${t.tf}:${t.pair}:${t.keyT ?? t.entryT}`;

/** A lab trade as the bot account takes it (v15: with its trailing take-profit and the exit rules still in force). */
export function toLabTrade(t: Trade, o: { chosen: boolean; sizeF: number; prio: number; judge: LabOpenTrade['judge']; conviction?: LabOpenTrade['conviction']; sniper?: LabOpenTrade['sniper'] }): LabOpenTrade {
  return {
    ref: tradeKey(t),
    strategy: t.strategy,
    tf: t.tf,
    pair: t.pair,
    side: t.side,
    entryT: t.entryT,
    stop: t.stop,
    target: t.target,
    chosen: o.chosen,
    sizeF: Math.round(o.sizeF * 100) / 100,
    prio: o.prio,
    judge: o.judge,
    conviction: o.conviction ?? null,
    sniper: o.sniper ?? null,
    beAt: t.beAt ?? null,
    scaleAt: t.scaleAt ?? null,
    scaleFrac: t.scaleFrac ?? null,
    scaled: t.scaled ?? false,
    tpTrailPx: t.tpTrailPx ?? null,
    tpFrac: t.tpFrac ?? null,
    tpHit: t.tpHit ?? false,
    trailPx: t.trailPx ?? null,
    trailAtr: t.trailAtr ?? null,
    maxBars: t.maxBars ?? null,
    exitWhen: t.exitWhen ?? null,
  };
}

/** One market on one chart, with everything its strategies and checks read. */
export interface Series {
  inst: Instrument;
  tf: Timeframe;
  ctx: Ctx;
  env: FilterEnv;
}

/** v15: the hourly market read (strength, mood, cross-market moves), shared with the 15m / 1m lab. */
export interface MarketBook {
  at: number;
  strength: StrengthBook;
  mood: MoodBook;
  ranks: Record<string, Float64Array>;
  zOil: TimeSeries | null;
  zYield: TimeSeries | null;
  zStocks: TimeSeries | null;
  zDollar: TimeSeries | null;
  spxMtd: TimeSeries | null;
  /** traded markets' hourly bars */
  h1: Map<string, Bar[]>;
  /** v16: CFTC positioning + policy rates (null until the first fetch) */
  macro?: MacroData | null;
}

/** A bigger chart's finished bars and its trend. */
export interface BigChart {
  bars: readonly SpanBar[];
  trend: Int8Array;
}
export const bigChart = (bars: readonly SpanBar[]): BigChart => ({ bars, trend: trendSeries(bars) });

/**
 * Build a series: indicators, every filter reading and the cross-market values, all read at each bar's close.
 * `big1` = the next bigger chart (must agree), `big2` = the one above (must not be against). Pure.
 */
export function makeSeries(inst: Instrument, tf: Timeframe, bars: Bar[], book: MarketBook, big1: BigChart | null, big2: BigChart | null): Series {
  const barMin = TF_MIN[tf];
  const dts = decisionTimes(bars, barMin);
  const env: FilterEnv = {
    tf,
    gap: gapSeries(book.strength, inst.id, bars, barMin),
    h4: big1 ? alignTrend(dts, big1.bars, big1.trend) : new Int8Array(bars.length),
    d1: big2 ? alignTrend(dts, big2.bars, big2.trend) : new Int8Array(bars.length),
    mood: moodSeries(book.mood, bars, barMin),
    riskLong: riskOfLong(inst.id),
  };
  const ctx = buildCtx(bars, barMin, inst.id);
  env.er = Float64Array.from(ctx.er20);
  const pr = pairRanks(book.strength, book.ranks, inst.id, bars, barMin);
  ctx.ext = { gap: env.gap, rankBase: pr.base, rankQuote: pr.quote, zOil: alignAt(book.zOil, bars, barMin), zYield: alignAt(book.zYield, bars, barMin), zStocks: alignAt(book.zStocks, bars, barMin), zDollar: alignAt(book.zDollar, bars, barMin), spxMtd: alignAt(book.spxMtd, bars, barMin), carry: carrySeries(book.macro ?? null, inst.id, bars, barMin), cot: cotSeries(book.macro ?? null, inst.id, bars, barMin) };
  env.carry = ctx.ext.carry;
  env.cot = ctx.ext.cot;
  if (ctx.quant) {
    env.volF = ctx.quant.volF;
    env.hurst = ctx.quant.hurst;
  }
  return { inst, tf, ctx, env };
}

/** One strategy's final variant on one chart (what the hourly lab feeds its judge / walk-forward / portfolio tests). */
export interface StrategyResult {
  s: Strategy;
  style: Style;
  key: string;
  tf: Timeframe;
  filter: FilterKind;
  exit: ExitKind;
  fStats: Array<{ filter: FilterKind } & Split>;
  ch: Split;
  /** the final variant's trades (closed + open) and closed ones */
  trades: Trade[];
  done: Trade[];
  /** no filter, designed exits */
  raw: Trade[];
}

export interface TfEval {
  rows: Row[];
  paperRows: PaperRow[];
  open: Trade[];
  recent: Trade[];
}

/**
 * Every strategy on one chart (v15: shared by the hourly lab and the 15m / 1m lab): raw and with each filter, then
 * every exit under the chosen filter — both picked on the FIRST 70% only (`oosFrom`), the owner's trailing
 * take-profit preferred where it tests as well — then each row's verdict against random entries on the same chart,
 * its paper results since `since` and its open trades. `onStrategy` sees each strategy's final variant.
 */
export async function evaluateTf(seriesTf: readonly Series[], tf: Timeframe, o: { oosFrom: number; since: number; weeks: number; prev: Record<string, { f?: FilterKind; e?: ExitKind }> }, onStrategy?: (x: StrategyResult) => void | Promise<void>): Promise<TfEval> {
  const rows: Row[] = [];
  const paperRows: PaperRow[] = [];
  const open: Trade[] = [];
  const recent: Trade[] = [];
  type Bucket = { trades: Trade[]; perPair: Row['pairs'] };
  for (const s of STRATEGIES) {
    if (!runsOn(s, tf)) continue;
    const style = styleOf(s);
    const key = `${s.id}:${tf}`;
    const prev = o.prev[key];
    // pass 1: every filter, exits as designed
    const sigsBy = new Map<Series, Array<Signal | null>>();
    const designedBy = new Map<string, Trade[]>();
    const byFilter = new Map<FilterKind, Bucket>(FILTERS.map((f) => [f, { trades: [], perPair: [] }]));
    for (const se of seriesTf) {
      const sigs = signalsFor(se.ctx, s);
      sigsBy.set(se, sigs);
      for (const f of FILTERS) {
        const ts = simulate(se.inst, tf, se.ctx, s.id, sigs, allowFor(f, se.env, style));
        designedBy.set(`${se.inst.id}:${f}`, ts);
        const b = byFilter.get(f)!;
        b.trades.push(...ts);
        b.perPair.push({ pair: se.inst.id, ...rStats(ts) });
        // the lab shares the bot's process: give the event loop a turn after every long simulation
        if (se.ctx.bars.length > 8_000) await yieldNow();
      }
      await yieldNow();
    }
    const fStats = FILTERS.map((f) => ({ filter: f, ...statsOf(byFilter.get(f)!.trades, o.oosFrom) }));
    const filter: FilterKind = s.id === 'random' ? 'none' : chooseFilter(fStats, 40, prev?.f);
    // pass 2: every exit under that filter (a variant that changes nothing for this strategy reuses the designed trades)
    const byExit = new Map<ExitKind, Bucket>([['designed', byFilter.get(filter)!]]);
    const differs = new Set<ExitKind>();
    if (s.id !== 'random') {
      for (const k of EXITS) if (k !== 'designed') byExit.set(k, { trades: [], perPair: [] });
      for (const se of seriesTf) {
        const sigs = sigsBy.get(se)!;
        const allow = allowFor(filter, se.env, style);
        for (const k of EXITS) {
          if (k === 'designed') continue;
          let same = true;
          const mapped = sigs.map((sg, i) => {
            const m = applyExit(sg, k, se.ctx, i);
            if (m !== sg) same = false;
            return m;
          });
          const ts = same ? designedBy.get(`${se.inst.id}:${filter}`)! : simulate(se.inst, tf, se.ctx, s.id, mapped, allow);
          if (!same) differs.add(k);
          const b = byExit.get(k)!;
          b.trades.push(...ts);
          b.perPair.push({ pair: se.inst.id, ...rStats(ts) });
          if (!same && se.ctx.bars.length > 8_000) await yieldNow();
        }
        await yieldNow();
      }
    }
    sigsBy.clear();
    designedBy.clear();
    const eStats = [...byExit.keys()].map((k) => ({ exit: k, ...statsOf(byExit.get(k)!.trades, o.oosFrom) }));
    let exit: ExitKind = s.id === 'random' ? 'designed' : chooseVariant(eStats.map((x) => ({ key: x.exit, inSample: x.inSample })), 'designed' as ExitKind, 40, prev?.e);
    // owner (v15, v15.1): a trailing stop-loss first, else a trailing take-profit, wherever it tests as well as the
    // best exit (first 70% only)
    if (s.id !== 'random' && FX_CONFIG.preferTrailing) {
      exit = preferVariant(
        eStats.filter((x) => x.exit === 'designed' || x.exit === exit || differs.has(x.exit)).map((x) => ({ key: x.exit, inSample: x.inSample })),
        exit,
        OWNER_EXITS,
        'designed' as ExitKind,
        40,
        prev?.e,
      );
    }
    const ch = eStats.find((x) => x.exit === exit)!;
    const v = byExit.get(exit)!;
    const done = v.trades.filter((t) => t.reason !== 'open');
    const vRow = (x: Split) => ({ inN: x.inSample.n, inAvgR: x.inSample.avgR, outN: x.outSample.n, outAvgR: x.outSample.avgR, outPf: x.outSample.pf, allN: x.all.n });
    rows.push({
      id: s.id,
      name: s.name,
      family: s.family,
      desc: s.desc,
      tf,
      filter,
      variants: fStats.map((x) => ({ filter: x.filter, ...vRow(x) })),
      exit,
      exitVariants: eStats.map((x) => ({ exit: x.exit, ...vRow(x) })),
      all: ch.all,
      inSample: ch.inSample,
      outSample: ch.outSample,
      tradesPerWeek: Math.round((done.length / o.weeks) * 10) / 10,
      risk: FX_CONFIG.riskLevelsPct.map((r) => equityCurve(done, r, FX_CONFIG.maxLeverage)),
      pairs: v.perPair.sort((a, b) => b.totalR - a.totalR).map((x) => ({ pair: x.pair, n: x.n, winPct: x.winPct, pf: x.pf, totalR: x.totalR })) as Row['pairs'],
      verdict: 'no',
      why: '',
    });
    const paper = v.trades.filter((t) => t.entryT >= o.since);
    const pDone = paper.filter((t) => t.reason !== 'open');
    const pOpen = paper.filter((t) => t.reason === 'open');
    paperRows.push({ id: s.id, name: s.name, tf, stats: rStats(pDone), risk1: equityCurve(pDone, 1, FX_CONFIG.maxLeverage), open: pOpen.length });
    open.push(...pOpen);
    recent.push(...pDone);
    await onStrategy?.({ s, style, key, tf, filter, exit, fStats, ch, trades: v.trades, done, raw: byFilter.get('none')!.trades });
  }
  // the verdict: against random entries with the same costs on the same chart
  const rnd = rows.find((r) => r.id === 'random');
  for (const r of rows) {
    if (r.id === 'random') {
      r.verdict = 'no';
      r.why = 'yardstick: random entries with the same costs';
      continue;
    }
    Object.assign(r, verdictFor(r, rnd ? rnd.all.avgR : null));
  }
  return { rows, paperRows, open, recent };
}

/** v15: one line per bot check (the plan's timeline), including the checks where nothing happened. */
export interface RunNote {
  t: number;
  /** '1h' (the hourly check: 1h + 4h charts), '15m', '1m' */
  tf: string;
  /** strategy signals on the newest close(s), all markets */
  signals: number;
  /** of them: strategies the bot trades, passing their checks */
  chosen: number;
  opened: number;
  skipped: number;
  waits: number;
  /** bot trades open on these charts after the check */
  holding: number;
  note: string;
}

/** Plain-words summary of one check. Pure. */
export function runNoteText(r: Omit<RunNote, 'note'>): string {
  const sig = r.signals ? `${r.signals} signal${r.signals > 1 ? 's' : ''}${r.chosen ? `, ${r.chosen} from strategies it trades` : ', none from strategies it trades'}` : 'nothing fired';
  const act = [r.opened ? `opened ${r.opened}` : '', r.skipped ? `skipped ${r.skipped}` : '', r.waits ? `waiting on ${r.waits}` : ''].filter(Boolean).join(', ');
  return `${sig}${act ? ` · ${act}` : ''}${r.holding ? ` · holding ${r.holding}` : ''}`;
}

export class ForexLab {
  private timer: NodeJS.Timeout | null = null;
  private dkTimer: NodeJS.Timeout | null = null;
  private running: Promise<FxReport | null> | null = null;
  /** set by index.ts: the account the bot auto-trades */
  practice: Practice | null = null;
  calendar: ForexCalendar | null = null;
  headlines: ForexHeadlines | null = null;
  /** strategy:chart combinations dropped by the bot because they lose in real time */
  dropped: string[] = [];
  botLog: Array<{ t: number; e: string }> = [];
  /** v15: the hourly market read, for the 15m / 1m lab */
  book: MarketBook | null = null;
  /** v15: the hourly range per market (price), for the price-shock guard */
  atr1h: Record<string, number> = {};
  /** v15: what the bot saw on its latest check, per chart group ('1h' = the hourly check, '15m', '1m') */
  lastSync: Record<string, SyncReport> = {};
  /** v15: one line per check, newest first */
  runs: RunNote[] = [];
  /** v15: strategy:chart combinations the bot trades (hourly check) */
  chosen: string[] = [];
  /** v15: open trades of the strategies the bot trades (`strategy:tf:pair` → entry time), for the plan */
  labOpen: Record<string, number> = {};
  /** v15: the latest market cards and mood, kept in memory for the bot's plan */
  marketsNow: MarketNow[] = [];
  moodNow: MoodNow | null = null;
  constructor(private readonly redis: Redis) {}

  start(): void {
    // keep the bot's decision log and check timeline across restarts
    void this.redis
      .mget('fx:bot:log', FX_BOT_RUNS, 'fx:bot:chosen')
      .then(([raw, runs, chosen]) => {
        if (raw && !this.botLog.length) this.botLog = (JSON.parse(raw) as Array<{ t: number; e: string }>).slice(0, 100);
        if (runs && !this.runs.length) this.runs = JSON.parse(runs) as RunNote[];
        if (chosen && !this.chosen.length) this.chosen = JSON.parse(chosen) as string[];
      })
      .catch(() => undefined);
    // the last report's market cards, until the first run of this process
    void this.last()
      .then((r) => {
        if (r && !this.marketsNow.length) {
          this.marketsNow = r.markets ?? [];
          this.moodNow = r.mood ?? null;
          this.atr1h = Object.fromEntries(this.marketsNow.map((m) => [m.id, m.atrPips * (INSTRUMENTS.find((i) => i.id === m.id)?.pip ?? 0)]));
        }
      })
      .catch(() => undefined);
    setTimeout(() => void this.run().catch(() => undefined), 45_000);
    // v16: Dukascopy history + real spreads — installed from Redis at once, refreshed 3 min after start, then daily
    void installSpreadProfiles(this.redis).catch(() => undefined);
    const dk = () => {
      void refreshDukascopy(this.redis).catch((err: Error) => log.warn({ err: err.message }, 'dukascopy failed'));
      // v16: CFTC positioning + central-bank rates (each refreshes itself at most every 12 h)
      void refreshMacro(this.redis).catch((err: Error) => log.warn({ err: err.message }, 'macro failed'));
    };
    this.dkTimer = setTimeout(() => {
      dk();
      this.dkTimer = setInterval(dk, 6 * 3_600_000);
    }, 3 * 60_000);
    // then 90 s after every full hour: the hourly candle has just closed (Yahoo / OANDA publish it within a minute)
    const next = () => {
      const now = Date.now();
      const at = Math.ceil((now - 90_000) / 3_600_000) * 3_600_000 + 90_000;
      this.timer = setTimeout(() => {
        void this.run().catch(() => undefined);
        next();
      }, Math.max(5_000, at - now));
    };
    next();
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.dkTimer) clearTimeout(this.dkTimer as NodeJS.Timeout);
  }
  isRunning(): boolean {
    return this.running !== null;
  }

  /** v15: add bot decisions to the log (newest first, 100 kept). */
  logBot(events: readonly string[], now = Date.now()): void {
    if (!events.length) return;
    for (const e of events) this.botLog.unshift({ t: now, e });
    this.botLog = this.botLog.slice(0, 100);
    void this.redis.set('fx:bot:log', JSON.stringify(this.botLog)).catch(() => undefined);
  }

  /** v15: record one check in the timeline (the newest 40 per chart group kept). */
  noteRun(r: Omit<RunNote, 'note'> & { note?: string }): void {
    this.runs.unshift({ ...r, note: r.note ?? runNoteText(r) });
    const per = new Map<string, number>();
    this.runs = this.runs.filter((x) => {
      const k = (per.get(x.tf) ?? 0) + 1;
      per.set(x.tf, k);
      return k <= 40;
    });
    void this.redis.set(FX_BOT_RUNS, JSON.stringify(this.runs)).catch(() => undefined);
  }

  async last(): Promise<FxReport | null> {
    const raw = await this.redis.get(FX_REPORT).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FxReport;
    } catch {
      return null;
    }
  }

  run(refresh = true): Promise<FxReport | null> {
    if (this.running) return this.running;
    this.running = this.doRun(refresh)
      .then((r) => {
        this.lastError = null;
        return r;
      })
      .catch((err: Error) => {
        // v17: a failed hourly run is logged and shown (it used to vanish)
        this.lastError = { t: Date.now(), msg: err?.message ?? String(err) };
        log.error({ err: this.lastError.msg }, 'forex lab run failed');
        throw err;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  /** v17: the last run's error (null after a good run) */
  lastError: { t: number; msg: string } | null = null;

  /** The bot's per strategy:chart record: losers (12+ trades, net loss) are dropped, winners sized a bit up. */
  async botRecord(): Promise<{ dropped: string[]; proven: Set<string> }> {
    const res = this.practice ? await this.practice.botResults().catch(() => ({} as Record<string, { n: number; pnlUsd: number }>)) : {};
    const dropped = Object.entries(res).filter(([, v]) => v.n >= 12 && v.pnlUsd < 0).map(([k]) => k);
    const proven = new Set(Object.entries(res).filter(([, v]) => v.n >= 12 && v.pnlUsd > 0).map(([k]) => k));
    return { dropped, proven };
  }

  private async doRun(refresh: boolean): Promise<FxReport | null> {
    const t0 = Date.now();
    const feed: FeedStatus[] = [];
    if (refresh) {
      for (const inst of INSTRUMENTS) {
        feed.push({ ...(await refreshInstrument(this.redis, inst)), role: 'traded' });
        await new Promise((r) => setTimeout(r, 700));
      }
      for (const p of STRENGTH_PAIRS) {
        feed.push({ ...(await refreshSeries(this.redis, p.id, p.yahoo)), role: 'strength' });
        await new Promise((r) => setTimeout(r, 700));
      }
      for (const m of MOOD_SYMBOLS) {
        feed.push({ ...(await refreshSeries(this.redis, `mood:${m.id}`, m.yahoo, Date.now(), 800)), id: m.id, role: 'mood' });
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    const since = await paperSince(this.redis, FX_PAPER_SINCE, Date.now());

    // ── market read: strength (traded FX + crosses), mood ──
    const h1ById = new Map<string, Bar[]>();
    // v16: Dukascopy's older bars in front of Yahoo's (FX only, when the seam lines up) → years more history to test on
    const nowT = Date.now();
    for (const inst of INSTRUMENTS) h1ById.set(inst.id, stitchHistory(inst.id, await loadBars(this.redis, inst.id), await loadDk(this.redis, inst.id), nowT));
    const strengthInput: Record<string, Bar[]> = {};
    for (const inst of INSTRUMENTS) if (inst.kind === 'fx') strengthInput[inst.id] = h1ById.get(inst.id)!;
    for (const p of STRENGTH_PAIRS) {
      const b = stitchHistory(p.id, await loadBars(this.redis, p.id), await loadDk(this.redis, p.id), nowT);
      strengthInput[p.id] = b;
      if (!refresh) feed.push({ id: p.id, role: 'strength', bars: b.length, firstT: b[0]?.t ?? null, lastT: b[b.length - 1]?.t ?? null, error: null });
    }
    const strength = buildStrength(strengthInput);
    await yieldNow();
    const moodInput: Partial<Record<(typeof MOOD_SYMBOLS)[number]['id'], Bar[]>> = {};
    for (const m of MOOD_SYMBOLS) {
      const b = await loadBars(this.redis, `mood:${m.id}`);
      if (b.length) moodInput[m.id] = b;
      if (!refresh) feed.push({ id: m.id, role: 'mood', bars: b.length, firstT: b[0]?.t ?? null, lastT: b[b.length - 1]?.t ?? null, error: null });
    }
    const mood = buildMood(moodInput);
    await yieldNow();

    // ── cross-market readings for the intermarket / momentum / flow strategies ──
    const book: MarketBook = {
      at: Date.now(),
      strength,
      mood,
      ranks: strengthRanks(strength),
      zOil: moodInput.OIL ? z24Series(moodInput.OIL) : null,
      zYield: moodInput.US10Y ? z24Series(moodInput.US10Y) : null,
      zStocks: moodInput.SPX ? z24Series(moodInput.SPX) : null,
      zDollar: moodInput.DXY ? z24Series(moodInput.DXY) : null,
      spxMtd: moodInput.SPX ? mtdSeries(moodInput.SPX) : null,
      h1: h1ById,
      macro: await loadMacro(this.redis),
    };
    this.book = book;
    await yieldNow();

    // ── series + their filter readings ──
    const series: Series[] = [];
    const trendNow = new Map<string, { h1: number; h4: number; d1: number }>();
    let from = Infinity;
    let to = -Infinity;
    for (const inst of INSTRUMENTS) {
      const h1 = h1ById.get(inst.id)!;
      if (!refresh) feed.push({ id: inst.id, role: 'traded', bars: h1.length, firstT: h1[0]?.t ?? null, lastT: h1[h1.length - 1]?.t ?? null, error: null });
      if (h1.length < 400) continue;
      from = Math.min(from, h1[0]!.t);
      to = Math.max(to, h1[h1.length - 1]!.t);
      const h4bars = withEnd(to4h(h1), 4 * HOUR);
      const big4h = bigChart(h4bars);
      const bigD = bigChart(toDaily(h1));
      for (const tf of FX_CONFIG.timeframes) {
        const bars = tf === '1h' ? h1 : h4bars.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
        if (bars.length < 400) continue;
        const se = makeSeries(inst, tf, bars, book, tf === '1h' ? big4h : null, bigD);
        series.push(se);
        if (tf === '1h') {
          const t1 = trendSeries(bars);
          trendNow.set(inst.id, { h1: t1[t1.length - 1] ?? 0, h4: se.env.h4[se.env.h4.length - 1] ?? 0, d1: se.env.d1[se.env.d1.length - 1] ?? 0 });
        }
      }
      await yieldNow();
    }
    if (!series.length) {
      const empty: FxReport = { at: Date.now(), durationMs: Date.now() - t0, feed, from: null, to: null, oosFrom: null, rows: [], markets: [], paper: { since, rows: [], open: [], recent: [] }, note: 'No forex candles yet. The server pulls them from Yahoo Finance; check the feed errors above.', strength: strengthNow(strength), mood: moodNow(mood) };
      await this.redis.set(FX_REPORT, JSON.stringify(empty)).catch(() => undefined);
      return empty;
    }
    const oosFrom = from + (1 - FX_CONFIG.oosFraction) * (to - from);
    const prevChosen: Record<string, { f?: FilterKind; e?: ExitKind }> = {};
    try {
      const raw = JSON.parse((await this.redis.get(FX_FILTERS_CHOSEN).catch(() => null)) ?? '{}') as Record<string, FilterKind | { f?: FilterKind; e?: ExitKind }>;
      for (const [k, v] of Object.entries(raw)) prevChosen[k] = typeof v === 'string' ? { f: v } : v;
    } catch {
      // first run: nothing to keep
    }
    const rows: Row[] = [];
    const paperRows: PaperRow[] = [];
    const open: Trade[] = [];
    const recent: Trade[] = [];
    /** unseen trades of the strategies the whole-bot test picks (new = with filters + exits, old = raw) */
    const poolNew: PTrade[] = [];
    const poolOld: PTrade[] = [];
    const pickedNew: PortfolioReport['picked'] = [];
    const pickedOld = new Set<string>();
    /** every raw (unfiltered, designed-exit) closed trade, for the walk-forward test */
    const wfPool: WTrade[] = [];
    /** context of every closed trade of the final variants (judge training); unseen + open ones by key (judge use) */
    const judgeRows: JudgeRow[] = [];
    const judgeX = new Map<string, Float64Array>();
    /** v15.2 conviction: closed trades of the picked strategies (market checks + judge features), and every open trade's checks */
    const convPend: Array<{ key: string; t: number; exitT: number; r: number; agree: number; x: Float64Array; extra: number }> = [];
    const openAgree = new Map<string, number>();
    /** v16 sniper: the extra votes (and their words) of every open trade */
    const openExtra = new Map<string, { total: number; yes: string[]; of: number }>();
    const seriesOf = new Map(series.map((se) => [`${se.inst.id}:${se.tf}`, se]));
    const weeks = Math.max(1, (to - from) / (7 * 86_400_000));
    for (const tf of FX_CONFIG.timeframes) {
      const ev = await evaluateTf(series.filter((se) => se.tf === tf), tf, { oosFrom, since, weeks, prev: prevChosen }, (x) => {
        if (x.s.id === 'random') return;
        // the judge's view of every trade: its context at the signal bar (and the strategy's last 10 results before it)
        const byExitT = [...x.done].sort((a, b) => a.exitT - b.exitT);
        const exitTs = byExitT.map((t) => t.exitT);
        const prefix = [0];
        for (const t of byExitT) prefix.push(prefix[prefix.length - 1]! + t.r);
        /** how many of the strategy's trades had finished before t */
        const doneBy = (t: number) => {
          let lo = 0;
          let hi = exitTs.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (exitTs[mid]! < t) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        const formAt = (entryT: number) => {
          const lo = doneBy(entryT);
          return prefix[lo]! - prefix[Math.max(0, lo - 10)]!;
        };
        // v17: the strategy's record so far (every trade finished before this one opened), not its whole first-70% average —
        // that average holds this trade's own result and later ones, which taught the judge to trust a number it can't know
        const priorAt = (entryT: number) => {
          const lo = doneBy(entryT);
          return lo >= 5 ? prefix[lo]! / lo : NaN;
        };
        const always = FX_CONFIG.botAlways.includes(x.s.id);
        const picked = always || pickedOnInSample(x.ch.inSample);
        for (const t of x.trades) {
          const se = seriesOf.get(`${t.pair}:${tf}`);
          if (!se) continue;
          const si = signalIndex(se.ctx.bars, t.entryT, se.ctx.barMin);
          if (si < 0) continue;
          // the target it was opened with (a trailing take-profit clears the live one: that would leak the outcome)
          const tgt = t.target0 !== undefined ? t.target0 : t.target;
          const fx = judgeFeatures(se.ctx, se.env, si, t.side, t.stop0, tgt, { style: x.style, prior: priorAt(t.entryT), form: formAt(t.entryT), tf });
          const agree = agreeCount(se.env, si, t.side);
          const ex = extraVotes(se.ctx, se.env, si, t.side, x.style);
          if (t.reason === 'open') {
            judgeX.set(tradeKey(t), fx);
            openAgree.set(tradeKey(t), agree);
            openExtra.set(tradeKey(t), ex);
          } else {
            judgeRows.push({ x: fx, r: t.r, t: t.entryT, exitT: t.exitT });
            if (t.entryT >= oosFrom) judgeX.set(tradeKey(t), fx);
            if (picked) convPend.push({ key: tradeKey(t), t: t.entryT, exitT: t.exitT, r: t.r, agree, x: fx, extra: ex.total });
          }
        }
        // walk-forward pool: the raw rules
        for (const t of x.raw) if (t.reason !== 'open') wfPool.push({ pair: t.pair, side: t.side, entryT: t.entryT, exitT: t.exitT, r: t.r, stopPct: t.stopPct, strategy: t.strategy, tf: t.tf, sizeF: 1, key: x.key, vf: volFactor(t.volRatio) });
        // whole-bot test: picked on the first 70% only, traded on the unseen 30%
        if (picked) {
          const sf = stratFactorFromStats(x.ch.inSample.avgR, x.ch.inSample.pf);
          const unseen = x.done.filter((t) => t.entryT >= oosFrom);
          for (const t of unseen) poolNew.push({ pair: t.pair, side: t.side, entryT: t.entryT, ...(t.keyT !== undefined ? { keyT: t.keyT } : {}), exitT: t.exitT, r: t.r, stopPct: t.stopPct, strategy: t.strategy, tf: t.tf, sizeF: sf * volFactor(t.volRatio), prio: x.ch.inSample.avgR });
          pickedNew.push({ id: x.s.id, name: x.s.name, tf, filter: x.filter, exit: x.exit, inAvgR: x.ch.inSample.avgR, inN: x.ch.inSample.n, unseenN: unseen.length });
        }
        const raw = x.fStats.find((y) => y.filter === 'none')!;
        if (always || pickedOnInSample(raw.inSample)) {
          pickedOld.add(x.key);
          for (const t of x.raw) if (t.reason !== 'open' && t.entryT >= oosFrom) poolOld.push({ pair: t.pair, side: t.side, entryT: t.entryT, exitT: t.exitT, r: t.r, stopPct: t.stopPct, strategy: t.strategy, tf: t.tf, sizeF: 1 });
        }
      });
      rows.push(...ev.rows);
      paperRows.push(...ev.paperRows);
      open.push(...ev.open);
      recent.push(...ev.recent);
    }
    const filters = summarizeFilters(rows);
    const exits = summarizeExits(rows);
    await this.redis.set(FX_FILTERS_CHOSEN, JSON.stringify(Object.fromEntries(rows.map((r) => [`${r.id}:${r.tf}`, { f: r.filter, e: r.exit }])))).catch(() => undefined);

    // ── signal judge: learns on the first 70%, graded once on the unseen 30% ──
    let judgeModel: JudgeModel | null = null;
    let judge: JudgeReport | null = null;
    try {
      const j = await trainJudge(judgeRows, oosFrom);
      judgeModel = j.model;
      judge = j.report;
      await this.redis.set(FX_JUDGE, JSON.stringify({ active: j.report.active, model: j.model })).catch(() => undefined);
      await this.redis.set('fx:judge:report', JSON.stringify(j.report)).catch(() => undefined);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'signal judge failed');
    }
    judgeRows.length = 0;
    // ── v15.2 bigger size when more sure: judge cut points from the first 70%, tiers graded on the unseen 30% ──
    const hasJudge = judgeModel !== null;
    const pOf = (x: Float64Array | undefined) => (judgeModel && x ? judgeProb(judgeModel, x) : null);
    const cuts = hasJudge ? judgeCuts(convPend.filter((c) => c.exitT < oosFrom).map((c) => pOf(c.x)!)) : { pHi: null, pTop: null };
    const confOf = new Map<string, number>();
    for (const c of convPend) confOf.set(c.key, confirmations(c.agree, pOf(c.x), cuts));
    const conviction = gradeConviction(convPend.map((c) => ({ t: c.t, exitT: c.exitT, r: c.r, conf: confOf.get(c.key)! })), oosFrom, 'hourly', hasJudge, cuts);
    // ── v16 sniper: every check's vote (market checks + quant engines + judge), K picked on the first 70%, graded unseen ──
    const votesOf = new Map<string, number>();
    for (const c of convPend) votesOf.set(c.key, confOf.get(c.key)! + c.extra);
    const sniper = gradeSniper(convPend.map((c) => ({ t: c.t, exitT: c.exitT, r: c.r, votes: votesOf.get(c.key)! })), oosFrom);
    convPend.length = 0;
    await this.redis.set(FX_CONVICTION, JSON.stringify(conviction)).catch(() => undefined);
    await this.redis.set(FX_SNIPER, JSON.stringify(sniper)).catch(() => undefined);
    rows.sort((a, b) => b.outSample.avgR * Math.min(1, b.outSample.n / 30) - a.outSample.avgR * Math.min(1, a.outSample.n / 30));
    paperRows.sort((a, b) => b.stats.totalR - a.stats.totalR);
    recent.sort((a, b) => b.exitT - a.exitT);
    open.sort((a, b) => b.entryT - a.entryT);
    await yieldNow();

    // ── whole-bot backtest on the unseen weeks ──
    let portfolio: PortfolioReport | null = null;
    if (poolNew.length || poolOld.length) {
      const base = { maxOpen: SIZING.maxOpen, leverage: SIZING.leverage, marginShare: SIZING.marginShare, from: oosFrom, to };
      // v15.6: a level that matches a bot risk mode is tested with that mode's leverage and caps (what the bot would do)
      const levels = FX_CONFIG.portfolioRiskPct.map((rp) => {
        const m = Object.values(RISK_MODES).find((x) => x.riskPct === rp);
        const lim = m ? { maxOpen: m.maxOpen, leverage: m.leverage, maxPerStrategy: m.maxPerStrategy, ccyCapPct: m.ccyCapPct } : { maxPerStrategy: SIZING.maxPerStrategy, ccyCapPct: SIZING.ccyCapPct * rp };
        return simulatePortfolio(poolNew, { ...base, label: m && m.riskPct !== 1 ? `${rp}% risk (${m.label})` : `${rp}% risk`, baseRiskPct: rp, prioritise: true, ddSizing: true, flatSizing: false, ...lim });
      });
      const old = simulatePortfolio(poolOld, { ...base, label: 'before the upgrade', baseRiskPct: 1, maxPerStrategy: null, prioritise: false, ccyCapPct: null, ddSizing: false, flatSizing: true });
      const upgraded = { maxPerStrategy: SIZING.maxPerStrategy, prioritise: true, ccyCapPct: SIZING.ccyCapPct, ddSizing: true, flatSizing: false };
      const judged = judgeModel
        ? simulatePortfolio(
            poolNew.filter((t) => {
              const x = judgeX.get(tradeKey(t));
              return !x || judgeProb(judgeModel!, x) >= judgeModel!.threshold;
            }),
            { ...base, ...upgraded, label: 'with the signal judge', baseRiskPct: 1 },
          )
        : null;
      // v15.2: the same bot with bigger size + leverage on the trades it is more sure of (only when proven)
      const convicted = conviction.active
        ? simulatePortfolio(
            poolNew.map((t) => {
              const b = boostFor(tierOf(confOf.get(tradeKey(t)) ?? 0, hasJudge), conviction);
              return b.mult > 1 ? { ...t, sizeF: t.sizeF * b.mult, maxMult: CONVICTION.maxRiskPct, lev: b.lev ?? undefined } : t;
            }),
            { ...base, ...upgraded, label: 'bigger size when sure', baseRiskPct: 1 },
          )
        : null;
      // v16: the same bot with the sniper trades (K+ votes) at the sniper size (only when proven)
      const sniped =
        sniper.active && sniper.k !== null
          ? simulatePortfolio(
              poolNew.map((t) => ((votesOf.get(tradeKey(t)) ?? 0) >= sniper.k! ? { ...t, sizeF: SNIPER.riskPct, maxMult: SNIPER.riskPct, lev: SNIPER.leverage, sniper: true } : t)),
              { ...base, ...upgraded, label: `sniper (${sniper.k}+ checks at ${SNIPER.riskPct}%)`, baseRiskPct: 1 },
            )
          : null;
      await yieldNow();
      const wf = walkForward(wfPool, {
        ...FX_CONFIG.walkForward,
        always: (k) => FX_CONFIG.botAlways.includes(k.split(':')[0]!),
        sim: { maxOpen: SIZING.maxOpen, leverage: SIZING.leverage, marginShare: SIZING.marginShare, baseRiskPct: 1, ...upgraded },
      });
      portfolio = {
        from: oosFrom,
        to,
        picked: pickedNew,
        oldPicked: pickedOld.size,
        levels,
        old,
        judged,
        walkForward: wf,
        convicted,
        sniped,
        note: `Strategies, their checks and their exits were picked on the first 70% of the history only; this is what the whole bot would have done on the last 30%, which it never saw: real spreads, max ${SIZING.maxOpen} trades at once (${SIZING.maxPerStrategy} per strategy), ${SIZING.leverage}× margin, the currency limit and the sizing rules.`,
      };
      await this.redis.set(FX_PORTFOLIO, JSON.stringify(portfolio)).catch(() => undefined);
    }
    wfPool.length = 0;
    await yieldNow();

    // ── what the bot trades: Edge / Maybe on unseen data + the published four, minus what lost in its own account ──
    const rec = await this.botRecord();
    this.dropped = rec.dropped;
    const chosenRows = rows.filter((x) => (x.verdict !== 'no' || FX_CONFIG.botAlways.includes(x.id)) && x.id !== 'random' && !rec.dropped.includes(`${x.id}:${x.tf}`));
    const chosen = new Set(chosenRows.map((x) => `${x.id}:${x.tf}`));
    this.chosen = [...chosen];

    // ── live market view ──
    const gNow = strength.times.length - 1;
    const markets: MarketNow[] = [];
    for (const inst of INSTRUMENTS) {
      const se = series.find((x) => x.inst.id === inst.id && x.tf === '1h');
      if (!se) continue;
      const c = se.ctx;
      const n = c.bars.length;
      const last = c.bars[n - 1]!;
      const firing: MarketNow['firing'] = [];
      for (const x of series.filter((y) => y.inst.id === inst.id)) {
        for (const s of STRATEGIES) {
          if (s.id === 'random' || !runsOn(s, x.tf)) continue;
          const sig = s.signal(x.ctx, x.ctx.bars.length - 1);
          if (!sig) continue;
          const f = rows.find((r) => r.id === s.id && r.tf === x.tf)?.filter ?? 'none';
          const why = blockReason(f, x.env, x.ctx.bars.length - 1, sig.side, styleOf(s));
          firing.push({ id: s.id, name: s.name, tf: x.tf, side: sig.side, allowed: why === null, why, chosen: chosen.has(`${s.id}:${x.tf}`) });
        }
      }
      const e50 = c.ema50[n - 1]!;
      const e200 = c.ema200[n - 1]!;
      const isMetal = inst.kind === 'metal';
      const baseScore = isMetal ? null : scoreAt(strength, inst.id.slice(0, 3), gNow);
      const quoteScore = scoreAt(strength, isMetal ? 'USD' : inst.id.slice(3, 6), gNow);
      const gap = se.env.gap[n - 1]!;
      const fin = (x: number | null) => (x !== null && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
      const dr = drawingsFor(c);
      markets.push({
        id: inst.id,
        label: inst.label,
        price: last.c,
        t: last.t,
        change24hPct: n > 24 ? Math.round((last.c / c.bars[n - 25]!.c - 1) * 10000) / 100 : 0,
        closes: c.close.slice(-72).map(px7),
        trend: e50 > e200 * 1.0005 ? 'up' : e50 < e200 * 0.9995 ? 'down' : 'flat',
        rsi: Math.round(c.rsi14[n - 1]!),
        atrPips: Math.round((c.atr14[n - 1]! / inst.pip) * 10) / 10,
        firing,
        openPaper: open.filter((t) => t.pair === inst.id).length,
        bars: c.bars.slice(-150).map((b) => [b.t, px7(b.o), px7(b.h), px7(b.l), px7(b.c)]),
        drawings: dr,
        heat: heatmapFor(c, se.env, dr, this.headlines?.expiries() ?? []),
        mtf: trendNow.get(inst.id) ?? { h1: 0, h4: 0, d1: 0 },
        strength: { base: inst.id.slice(0, 3), quote: inst.id.slice(3, 6), baseScore: fin(baseScore), quoteScore: fin(quoteScore), gap: fin(gap) },
        risk: Math.round(riskOfLong(inst.id) * 10) / 10,
      });
    }
    this.atr1h = Object.fromEntries(markets.map((m) => [m.id, m.atrPips * (INSTRUMENTS.find((i) => i.id === m.id)?.pip ?? 0)]));

    // ── after big moves ──
    let news: NewsStudy | null = null;
    try {
      news = newsStudy(series.filter((x) => x.tf === '1h').map((x) => ({ pair: x.inst.id, ctx: x.ctx })), this.calendar?.history() ?? []);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'news study failed');
    }

    const edges = rows.filter((r) => r.verdict === 'edge').length;
    const filtered = rows.filter((r) => r.id !== 'random' && r.filter !== 'none').length;
    const report: FxReport = {
      at: Date.now(),
      durationMs: Date.now() - t0,
      feed,
      from,
      to,
      oosFrom,
      rows,
      markets,
      paper: { since, rows: paperRows, open: open.slice(0, 300).map(slimTrade), recent: recent.slice(0, 150).map(slimTrade) },
      note: `${rows.length} strategy × timeframe combinations on ${INSTRUMENTS.length} markets, each tried raw and with ${FILTERS.length - 1} filters (${filtered} kept one) and ${EXITS.length - 1} exit variants (${rows.filter((r) => r.id !== 'random' && r.exit !== 'designed').length} kept one). ${edges} pass on unseen data. Many were tested at once, so expect a few to pass by luck: the paper results decide.`,
      strength: strengthNow(strength),
      mood: moodNow(mood),
      filters,
      exits,
      judge,
      portfolio,
      news,
      conviction,
      sniper,
      extFeeds: await (async () => {
        let dk: DkMeta | null = null;
        try {
          dk = JSON.parse((await this.redis.get(DK_META)) ?? 'null') as DkMeta | null;
        } catch {
          dk = null;
        }
        return { dukascopy: dk, spreadProfiles: INSTRUMENTS.filter((x) => hasSpreadProfile(x.id)).map((x) => x.id), macro: macroNow(book.macro ?? null), historyFrom: from };
      })(),
    };
    await this.redis.set(FX_REPORT, JSON.stringify(report)).catch(() => undefined);
    this.marketsNow = markets;
    this.moodNow = report.mood ?? null;
    this.labOpen = Object.fromEntries(open.filter((t) => chosen.has(`${t.strategy}:${t.tf}`)).map((t) => [`${t.strategy}:${t.tf}:${t.pair}`, t.entryT]));
    if (this.practice) {
      const rowOf = new Map(chosenRows.map((x) => [`${x.id}:${x.tf}`, x]));
      const sync = newSyncReport();
      const ev = await this.practice
        .syncBot(
          open.map((t) => {
            const row = rowOf.get(`${t.strategy}:${t.tf}`);
            const sizeF = (row ? stratFactorFromVerdict(row.verdict) : 1) * volFactor(t.volRatio) * (rec.proven.has(`${t.strategy}:${t.tf}`) ? 1.15 : 1);
            const x = judgeX.get(tradeKey(t));
            const p = judgeModel && x ? judgeProb(judgeModel, x) : null;
            const judgeOk = !judge?.active || !judgeModel || p === null || p >= judgeModel.threshold;
            const conf = confirmations(openAgree.get(tradeKey(t)) ?? 0, p, cuts);
            const b = boostFor(tierOf(conf, hasJudge), conviction);
            return toLabTrade(t, {
              chosen: chosen.has(`${t.strategy}:${t.tf}`),
              sizeF,
              prio: row ? row.all.avgR : -1,
              judge: p === null ? null : { p: Math.round(p * 100) / 100, ok: judgeOk, need: judgeModel ? Math.round(judgeModel.threshold * 100) / 100 : null },
              conviction: { tier: b.tier, conf, of: maxConfirmations(t.tf, hasJudge), mult: b.mult, lev: b.lev },
              sniper: (() => {
                const ex = openExtra.get(tradeKey(t));
                if (!ex) return null;
                const votes = conf + ex.total;
                return { votes, of: maxConfirmations(t.tf, hasJudge) + ex.of, k: sniper.k, on: sniper.active && sniper.k !== null && votes >= sniper.k, yes: ex.yes };
              })(),
            });
          }),
          (pair) => this.calendar?.blockFor(pair) ?? this.headlines?.blockFor(pair) ?? null,
          this.atr1h,
          // v17: a held trade on a market with no fresh hourly candles this run is kept (the lab couldn't see it end)
          { scope: FX_CONFIG.timeframes, report: sync, pairsSeen: new Set(series.filter((se) => se.tf === '1h' && se.ctx.bars.length && se.ctx.bars[se.ctx.bars.length - 1]!.t + 4 * 3_600_000 >= Date.now()).map((se) => se.inst.id)) },
        )
        .catch((err: Error) => [`bot sync failed: ${err.message}`]);
      this.lastSync['1h'] = sync;
      this.logBot(ev);
      const firing = markets.flatMap((m) => m.firing);
      this.noteRun({ t: Date.now(), tf: '1h', signals: firing.length, chosen: firing.filter((f) => f.chosen && f.allowed).length, opened: sync.opened, skipped: sync.skipped.length, waits: sync.waits.length, holding: sync.heldOpen + sync.opened });
      await this.redis.set('fx:bot:chosen', JSON.stringify([...chosen])).catch(() => undefined);
      await this.redis.set('fx:bot:dropped', JSON.stringify(rec.dropped)).catch(() => undefined);
    }
    log.info({ rows: rows.length, edges, filtered, ms: report.durationMs }, 'forex lab run done');
    return report;
  }
}
