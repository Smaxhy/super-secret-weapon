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
import { buildCorrBook, gradeHeat, HEAT, roundedMatrix, type HeatGrade } from './risk';
import { luckDowngrade, luckFor } from './luck';
import { learnFromLedger, type LearnKey } from './learner';
import { gradeRolling, nullKey, randomPickerNull, ROLL, rollRow, rollWeeks, type NullStats, type RollReport, type RollRow, type RollTrade } from './rolling';
import { FILL, fillFromDk, type FillResult } from './fill';
import { dataAgeOf, staleReason, type DataAge } from './freshness';
import { feeds, type BreakerState, type FeedId, type FeedState, type Provider } from './feeds';
import { afterLabRun, forkLabRun, heapFor, labWorkerOn, learnerSource, learnerTighten, LAB_WORKER, NO_STREAK, planLabRun, tightenOut, tightenState, type LearnerTighten, type WorkerStreak } from './lab-runner';
import { moduleLogger } from '../lib/logger';
import { refreshInstrument, refreshSeries, loadBars, type FeedStatus } from './data';
import { DK_META, refreshDkTail, installSpreadProfiles, loadDk, refreshDukascopy, stitchHistory, type DkMeta } from './dukascopy';
import { hasSpreadProfile } from './spreads';
import { carryAt, carrySeries, cotSeries, loadMacro, macroNow, refreshMacro, type MacroData } from './macro';
import { FINANCING } from './financing';
import { RISK_MODES, newSyncReport, type HeatLive, type LabOpenTrade, type Practice, type SyncReport } from './practice';
import { marketClock, type ForexCalendar } from './calendar';
import type { ForexHeadlines } from './headlines';
import { DEFAULT_SIM, equityCurve, rStats, signalsFor, simulate, type RiskResult, type RStats } from './engine';
import { STRATEGIES, runsOn, strategyById, styleOf, type Family, type Strategy, type Style } from './strategies';
import { buildCtx, to4h, type Ctx } from './ta';
import { drawingsFor, type Drawings } from './drawings';
import { applyDesks, buildDesks, type MarketDesk } from './desks';
import { ledgerRows } from './practice';
import { INSTRUMENTS, MOOD_SYMBOLS, STRENGTH_PAIRS, TF_MIN, type Bar, type Instrument, type Signal, type Timeframe, type Trade } from './types';
import { buildStrength, gapSeries, scoreAt, strengthNow, type StrengthBook, type StrengthNow } from './strength';
import { buildStretch, crowdPxSeries, type StretchBook } from './stretch';
import { filterHmm, hmmRegime, hmmReturns, type HmmModel } from './hmm';
import { dsrDowngrade, honestStats, type HonestReport, type RowStat, type StatInput } from './honest';
import { deskFromBars, FX_DESK, type DeskOut } from './desk';
import { alignTrend, decisionTimes, toDaily, trendSeries, withEnd, type SpanBar } from './mtf';
import { buildMood, moodNow, moodSeries, riskOfLong, type MoodBook, type MoodNow } from './mood';
import { FILTERS, FILTER_LABEL, allowFor, blockReason, chooseFilter, chooseVariant, filterCoverage, missingInput, preferVariant, type FilterEnv, type FilterKind } from './filters';
import { chooseEntry, ENTRIES, ENTRY, entryVariantRow, summarizeEntries, type EntryKind, type EntrySummary, type EntryVariantRow } from './entries';
import { SIZING, simulatePortfolio, stratFactorFromStats, stratFactorFromVerdict, volFactor, walkForward, weekOf, type PortfolioResult, type PTrade, type WalkForward, type WTrade } from './portfolio';
import { newsStudy, type NewsStudy } from './news-study';
import { EXITS, EXIT_LABEL, OWNER_EXITS, applyExit, type ExitKind } from './exits';
import { judgeFeatures, judgeKeeps, judgeMainP, judgeScores, judgeView, trainJudge, type JudgeModel, type JudgeReport, type JudgeRow } from './judge';
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
  /** v18.4: let a strategy trade with a limit / pullback entry once that proved better on its first 70% (entries.ts).
   * v20.1 (owner: "trade only what will work"): OFF — market entries only until the entry lab proves itself on real data
   * (a pullback order fills on the signals that came back against the trade and misses the ones that ran). */
  liveEntries: false,
  /** v20.1 strict mode (owner: "I want to win, make it trade only what will work with proper research"):
   * mode (v20.4, below) — which rows the bot may trade; in 'edge' / 'quality' the always-on four and the rolling
   *   picker's list no longer let a row in on their own;
   * minAgree — a trade needs this many of the market checks (strength gap, 4h trend, daily trend, mood) on its side at
   *   the signal close, else it waits;
   * deskTrades — the market desks' daily learning trades (v20) are OFF: the desks rank and study, they don't trade. */
  strict: {
    /** v20.4 (owner: "make the bot trade again, but good setups, not a random chase"):
     * 'edge' = only verdict Edge rows (v20.1; on the real feed that was 0 rows for a day);
     * 'quality' = rows that pass `qualityPass`: 30+ unseen trades, ≥ 0.05R a trade and PF ≥ 1.2 there, positive in the
     *   first part too, at least as good as random timing, not beaten by the luck twins — the deflated Sharpe is shown
     *   but does not gate (with 80+ rows graded on the same weeks it clears nothing on 2 years of hourly data);
     * 'off' = the v18.9 chooser (Edge + Maybe + the always-on four / the rolling picker). */
    mode: 'quality' as 'edge' | 'quality' | 'off',
    minAgree: 2,
    deskTrades: false,
    /** v20.4: a strategy may only open on a market where its own tested record there is a winning one */
    market: { minN: 12, minPf: 1.1 },
  },
  /** v18.7 (owner: "we can't fast trade these charts, they take time"): the bot account trades the 1h + 4h charts only.
   * The 15m / 1m charts stay lab-tested (Strategies / Lab) but place no bot trades while this is off. */
  botFastCharts: false,
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
  /** v20.4: does it clear the quality bar the bot trades on in strict 'quality' mode (and why not) */
  quality?: { ok: boolean; why: string };
  /** v17 luck meter: where its unseen R falls among 20 random-timing copies (weekend job; same filter + exit only) */
  luck?: { pctl: number; twinsP90: number; twinPassPct: number };
  /** v17.11: the same filter + exit WITHOUT the owner's profit lock (what the lock changed) */
  noLock?: { inN: number; inAvgR: number; outN: number; outAvgR: number; outPf: number | null; allN: number };
  /** v18: the deflated Sharpe of its unseen trades (honest.ts) — P(the edge is real) given every row graded on them */
  stats?: RowStat;
  /** v18 entry-timing lab: the same filter + exit with a limit / pullback / confirmation entry; v18.4: `entry` = the way in
   * it trades with (picked on the first 70% only; 'market' unless a limit / pullback entry proved better there) */
  entryVariants?: EntryVariantRow[];
  entry?: EntryKind;
  /** v18: R a trade earned (+) / paid (−) as overnight financing, first 70% / unseen 30% (inside the R above);
   * `known` = the rates feed covered its trades */
  fin?: { inAvgR: number; outAvgR: number; known: boolean };
}

/** v18: what overnight financing (carry minus the broker markup) does to the tested results */
export interface FinancingSummary {
  on: boolean;
  markupPct: number;
  /** strategy rows (not random) and how many had a rates feed behind their trades */
  rows: number;
  known: number;
  /** average financing R a trade across the known rows, first 70% / unseen */
  inAvgR: number;
  outAvgR: number;
  /** the rows it hurts / helps most on the unseen 30% */
  hurt: Array<{ id: string; tf: Timeframe; outAvgR: number }>;
  helped: Array<{ id: string; tf: Timeframe; outAvgR: number }>;
}

/** Pure: the financing summary across the rows. */
export function summarizeFinancing(rows: ReadonlyArray<Pick<Row, 'id' | 'tf' | 'fin'>>): FinancingSummary {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const known = rows.filter((r) => r.id !== 'random' && r.fin?.known);
  const n = known.length;
  const sorted = [...known].sort((a, b) => a.fin!.outAvgR - b.fin!.outAvgR);
  return {
    on: FINANCING.on,
    markupPct: FINANCING.markupPct,
    rows: rows.filter((r) => r.id !== 'random').length,
    known: n,
    inAvgR: n ? r3(known.reduce((s, r) => s + r.fin!.inAvgR, 0) / n) : 0,
    outAvgR: n ? r3(known.reduce((s, r) => s + r.fin!.outAvgR, 0) / n) : 0,
    hurt: sorted.slice(0, 3).filter((r) => r.fin!.outAvgR < 0).map((r) => ({ id: r.id, tf: r.tf, outAvgR: r3(r.fin!.outAvgR) })),
    helped: sorted.slice(-3).reverse().filter((r) => r.fin!.outAvgR > 0).map((r) => ({ id: r.id, tf: r.tf, outAvgR: r3(r.fin!.outAvgR) })),
  };
}

/** v17.11: what the owner's profit lock changed across the strategies (each on its own filter + exit) */
export interface LockSummary {
  on: boolean;
  /** strategies compared (30+ trades in the first 70%) */
  compared: number;
  /** average change in R a trade, first 70% / unseen 30% (with − without) */
  inDeltaR: number;
  outDeltaR: number;
  /** of those with 15+ unseen trades: share where the lock did better */
  outBetterPct: number;
  /** strategies the bot trades (Edge / Maybe): unseen R a trade with / without the lock */
  traded: { n: number; withR: number; withoutR: number };
}

/** Pure: the profit lock's effect, strategy by strategy (with vs without, same filter + exit). */
export function summarizeLock(rows: ReadonlyArray<Pick<Row, 'id' | 'verdict' | 'inSample' | 'outSample' | 'noLock'>>, on: boolean): LockSummary {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  let compared = 0;
  let inD = 0;
  let outD = 0;
  let outN = 0;
  let better = 0;
  let tn = 0;
  let tw = 0;
  let to = 0;
  for (const r of rows) {
    if (r.id === 'random' || !r.noLock) continue;
    if (r.inSample.n >= 30 && r.noLock.inN >= 30) {
      compared++;
      inD += r.inSample.avgR - r.noLock.inAvgR;
      if (r.outSample.n >= 15 && r.noLock.outN >= 15) {
        outN++;
        outD += r.outSample.avgR - r.noLock.outAvgR;
        if (r.outSample.avgR > r.noLock.outAvgR) better++;
      }
    }
    if (r.verdict !== 'no' && r.outSample.n && r.noLock.outN) {
      tn += r.outSample.n;
      tw += r.outSample.avgR * r.outSample.n;
      to += r.noLock.outAvgR * r.noLock.outN;
    }
  }
  return { on, compared, inDeltaR: compared ? r2(inD / compared) : 0, outDeltaR: outN ? r2(outD / outN) : 0, outBetterPct: outN ? Math.round((better / outN) * 100) : 0, traded: { n: tn, withR: tn ? r2(tw / tn) : 0, withoutR: tn ? r2(to / tn) : 0 } };
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
  /** v17: the upgraded bot at 1% with the correlated-risk cap, and whether that earned its place */
  heated?: PortfolioResult | null;
  heatWhy?: string;
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
  /** v17.11 the owner's profit lock: what it changed (with vs without, per strategy) */
  lock?: LockSummary;
  judge?: JudgeReport | null;
  /** v15.2: bigger size when more sure — the tiers and whether they proved themselves */
  conviction?: ConvictionReport | null;
  /** v16: the sniper vote level and whether it proved itself */
  sniper?: SniperReport | null;
  /** v16: extra data feeds (Dukascopy history + spreads, CFTC positioning, policy rates) */
  extFeeds?: { dukascopy: DkMeta | null; spreadProfiles: string[]; macro: ReturnType<typeof macroNow>; historyFrom: number };
  /** v17: how up to date each market's hourly prices are (stale ones get no new bot trades) */
  dataAge?: DataAge[];
  /** v18: how much of the lab's selection is luck (deflated Sharpe trials, PBO, Reality Check / SPA) */
  honest?: HonestReport;
  /** v18: the quant desk — the Carver-style vol-targeted forecast system, graded on the unseen 30% */
  desk?: DeskOut | null;
  /** v18: does a limit / pullback / confirmation entry beat entering at the next open? (graded only) */
  entries?: EntrySummary[];
  /** v18: overnight financing (carry minus the broker markup) inside every tested trade */
  financing?: FinancingSummary;
}

export const FX_REPORT = 'fx:report';
export const FX_PAPER_SINCE = 'fx:paper:since';
export const FX_PORTFOLIO = 'fx:portfolio';
/** last hour's filter + exit per strategy × timeframe (keeps near-ties from flipping) */
export const FX_FILTERS_CHOSEN = 'fx:filters:chosen';
/** v17.8: `fx:filters:chosen` / `fx:fast:chosen` = the picks + the 70/30 line they were made under (one number, or per chart) */
export interface ChosenStore {
  oosFrom: number | Record<string, number>;
  picks: Record<string, { f?: FilterKind; e?: ExitKind; n?: EntryKind }>;
}
/** v17.8: how far the 70/30 line may move back before last run's picks stop counting */
export const PICK_LINE_SLACK_MS = 86_400_000;
/**
 * v17.8: last run's filter / exit picks on chart `tf`, kept through near-ties only while the 70/30 line has not moved
 * back more than a day. History growing backward (the Dukascopy back-fill) moves the line back ~111 days in one run: a
 * pick made while those days were in-sample must not steer the variant graded on them now that they are unseen. A
 * forward move is harmless. The old unstamped format (and garbage) → nothing kept: one re-pick on deploy. Pure.
 */
export function prevPicks(raw: string | null | undefined, tf: string, oosFrom: number): Record<string, { f?: FilterKind; e?: ExitKind; n?: EntryKind }> {
  let s: Partial<ChosenStore> | null;
  try {
    s = JSON.parse(raw ?? 'null') as Partial<ChosenStore> | null;
  } catch {
    return {};
  }
  if (!s || typeof s !== 'object' || !s.picks || typeof s.picks !== 'object') return {};
  const line = typeof s.oosFrom === 'number' ? s.oosFrom : s.oosFrom && typeof s.oosFrom === 'object' ? (s.oosFrom as Record<string, unknown>)[tf] : undefined;
  if (typeof line !== 'number' || !Number.isFinite(line) || !Number.isFinite(oosFrom) || line - oosFrom > PICK_LINE_SLACK_MS) return {};
  const out: Record<string, { f?: FilterKind; e?: ExitKind; n?: EntryKind }> = {};
  for (const [k, v] of Object.entries(s.picks)) {
    if (!k.endsWith(`:${tf}`) || !v || typeof v !== 'object') continue;
    out[k] = { ...(typeof v.f === 'string' ? { f: v.f } : {}), ...(typeof v.e === 'string' ? { e: v.e } : {}), ...(typeof v.n === 'string' ? { n: v.n } : {}) };
  }
  return out;
}
/** the signal judge (trees + threshold), for the live bot */
export const FX_JUDGE = 'fx:judge';
/** v15: the bot's check timeline */
export const FX_BOT_RUNS = 'fx:bot:runs';
/** v15.2: conviction tiers (hourly charts) */
export const FX_CONVICTION = 'fx:conviction';
/** v16: sniper grade */
export const FX_SNIPER = 'fx:sniper';

/** v17.2: what the child process carries over from the parent's last run. */
export interface WorkerInput {
  learned: Record<string, LearnKey>;
  learnSig: string;
  chosenSig: string;
  heatActive: boolean | null;
  /** v17: the parent's per-provider breakers (the child honours an open one) */
  breakers?: Partial<Record<Provider, BreakerState>>;
}
/** v17.2: what the live bot (parent) needs after a run in the child. */
export interface WorkerState {
  marketsNow: MarketNow[];
  moodNow: MoodNow | null;
  atr1h: Record<string, number>;
  labOpen: Record<string, number>;
  chosen: string[];
  chooser: 'rolling' | 'verdict';
  dataAge: Record<string, DataAge>;
  dropped: string[];
  learned: Record<string, LearnKey>;
  learnSig: string;
  chosenSig: string;
  heat: { active: boolean; idx: Record<string, number>; m: number[] | null } | null;
  book: MarketBook | null;
  logs: string[];
}
export type WorkerResult =
  | { ok: true; out: RunOutput | null; state: WorkerState; feeds: Partial<Record<FeedId, FeedState>>; /** v17: the child's breakers (newer update wins in the parent) */ breakers?: Partial<Record<Provider, BreakerState>> }
  | { ok: false; error: string; /** v17: what the child's feeds / breakers saw before it failed */ feeds?: Partial<Record<FeedId, FeedState>>; breakers?: Partial<Record<Provider, BreakerState>> };

/** v17.2: what one hourly run hands to the bot sync (in worker mode: what the child hands to the parent). */
export interface RunOutput {
  report: FxReport;
  botTrades: LabOpenTrade[];
  pairsSeen: string[];
  chosen: string[];
  dropped: string[];
  firing: { signals: number; chosen: number };
  /** nothing to sync (no candles yet) */
  noSync?: boolean;
}
/** v17: the rolling picker's report, this week's list (+ last week's, + on / off), the random pickers (cached weekly) */
/** v20: the market desks' report (per market: ranked arms, today's trades, the learning pick) */
export const FX_DESKS = 'fx:desks';
export const FX_ROLL = 'fx:roll';
export const FX_ROLL_PICKS = 'fx:roll:picks';
export const FX_ROLL_NULL = 'fx:roll:null';
/** v17: point-in-time history of the bot's chosen list */
export const FX_CHOSEN_HIST = 'fx:chosen:hist';
/** v17: the luck meter's last weekend run */
export const FX_LUCK = 'fx:luck';
export interface LuckStore {
  at: number;
  oosFrom: number;
  rows: Record<string, { variant: string; twins: number[]; twinsP90: number; pctl: number; twinPassPct: number }>;
}
/** v17: the correlated-risk cap's grade + the latest correlations (for the dashboard) */
export const FX_HEAT = 'fx:heat';
/** v17: the restricted learner's states */
export const FX_LEARN = 'fx:learn';
export interface RollPicksState {
  week: number;
  keys: string[];
  /** the week's size factor per key (frozen with the list) */
  sizes?: Record<string, number>;
  active: boolean;
  prevKeys: string[] | null;
}

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

/** v20.4 pure: the quality bar for strict 'quality' mode. Stricter than Maybe (needs ≥ 0.05R a trade AND PF ≥ 1.2 on the
 * unseen 30%, a positive first part, at least random's R over all trades, and not beaten by its luck twins), looser than
 * Edge only in that the deflated Sharpe is reported, not required. */
export function qualityPass(row: Pick<Row, 'id' | 'inSample' | 'outSample' | 'all' | 'luck'>, randomAvgR: number | null): { ok: boolean; why: string } {
  const o = row.outSample;
  const i = row.inSample;
  if (row.id === 'random') return { ok: false, why: 'yardstick' };
  if (o.n < FX_CONFIG.minOosTrades) return { ok: false, why: `only ${o.n} unseen trades (needs ${FX_CONFIG.minOosTrades})` };
  if (!(o.avgR >= 0.05)) return { ok: false, why: `unseen ${o.avgR}R a trade (needs 0.05R+)` };
  if ((o.pf ?? 99) < 1.2) return { ok: false, why: `unseen profit factor ${o.pf} (needs 1.2+)` };
  if (!(i.avgR > 0)) return { ok: false, why: `lost in the first part (${i.avgR}R a trade)` };
  if (randomAvgR !== null && row.all.avgR < randomAvgR) return { ok: false, why: `random timing did better over all trades (${randomAvgR}R vs ${row.all.avgR}R)` };
  if (row.luck && Number.isFinite(row.luck.twinsP90) && o.avgR <= row.luck.twinsP90) return { ok: false, why: `its luck twins did as well (their top 10%: ${row.luck.twinsP90}R vs ${o.avgR}R)` };
  return { ok: true, why: `unseen ${o.n} trades, ${o.avgR}R a trade, PF ${o.pf ?? '∞'}; positive before the split too; beats random and its luck twins` };
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
  // missing → set only if still missing; present but unreadable → repaired (else the paper test stays empty for good)
  if (raw === null) await redis.set(key, String(now), 'NX');
  else await redis.set(key, String(now));
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
export function toLabTrade(t: Trade, o: { chosen: boolean; sizeF: number; prio: number; judge: LabOpenTrade['judge']; conviction?: LabOpenTrade['conviction']; sniper?: LabOpenTrade['sniper']; dataWait?: string | null; order?: LabOpenTrade['order']; agree?: LabOpenTrade['agree']; marketRec?: LabOpenTrade['marketRec'] }): LabOpenTrade {
  return {
    ...(o.order ? { order: o.order } : {}),
    ...(o.agree ? { agree: o.agree } : {}),
    ...(o.marketRec ? { marketRec: o.marketRec } : {}),
    ref: tradeKey(t),
    strategy: t.strategy,
    tf: t.tf,
    pair: t.pair,
    side: t.side,
    entryT: t.entryT,
    entry: t.entry,
    ...(o.dataWait ? { dataWait: o.dataWait } : {}),
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
  /** v18: the regime model fitted on this series' first 70% (null = none; undefined = not attached yet) */
  hmm?: HmmModel | null;
}

/**
 * v18: fit the hidden-Markov regime model on the bars BEFORE `oosFrom` only and read every bar causally
 * (`env.hmmHi` / `env.hmmLo`). Idempotent. Returns the model (null when the fit window is too short).
 */
export function attachHmm(se: Series, oosFrom: number): HmmModel | null {
  if (se.hmm !== undefined) return se.hmm;
  const bars = se.ctx.bars;
  let fitBars = bars.findIndex((b) => b.t >= oosFrom);
  if (fitBars < 0) fitBars = bars.length;
  const reg = hmmRegime(se.ctx.close, fitBars);
  se.hmm = reg ? reg.model : null;
  if (reg) {
    se.env.hmmHi = reg.pHigh;
    se.env.hmmLo = reg.pLow;
  }
  return se.hmm;
}

/** v18: read a (live) series with a model fitted elsewhere (the fast lab's stored model for that chart × market). */
export function applyHmm(se: Series, model: HmmModel): void {
  const r = hmmReturns(se.ctx.close);
  const post = filterHmm(model, r.slice(1));
  const n = se.ctx.close.length;
  const hi = new Float64Array(n);
  const lo = new Float64Array(n);
  hi[0] = NaN;
  lo[0] = NaN;
  for (let i = 1; i < n; i++) {
    hi[i] = post[model.hi]![i - 1]!;
    lo[i] = post[model.lo]![i - 1]!;
  }
  se.env.hmmHi = hi;
  se.env.hmmLo = lo;
  se.hmm = model;
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
  /** v17: price stretch per currency (no outside feed) */
  stretch?: StretchBook | null;
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
  ctx.ext = { gap: env.gap, rankBase: pr.base, rankQuote: pr.quote, zOil: alignAt(book.zOil, bars, barMin), zYield: alignAt(book.zYield, bars, barMin), zStocks: alignAt(book.zStocks, bars, barMin), zDollar: alignAt(book.zDollar, bars, barMin), spxMtd: alignAt(book.spxMtd, bars, barMin), carry: carrySeries(book.macro ?? null, inst.id, bars, barMin), cot: cotSeries(book.macro ?? null, inst.id, bars, barMin), crowdPx: crowdPxSeries(book.stretch, inst.id, bars, barMin) };
  env.carry = ctx.ext.carry;
  env.cot = ctx.ext.cot;
  env.crowdPx = ctx.ext.crowdPx;
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
export async function evaluateTf(seriesTf: readonly Series[], tf: Timeframe, o: { oosFrom: number; since: number; weeks: number; prev: Record<string, { f?: FilterKind; e?: ExitKind; n?: EntryKind }> }, onStrategy?: (x: StrategyResult) => void | Promise<void>): Promise<TfEval> {
  const rows: Row[] = [];
  const paperRows: PaperRow[] = [];
  const open: Trade[] = [];
  const recent: Trade[] = [];
  type Bucket = { trades: Trade[]; perPair: Row['pairs'] };
  // v18: the regime model per series (fitted on its first 70% only) for the 'hmm' filter
  for (const se of seriesTf) {
    attachHmm(se, o.oosFrom);
    await yieldNow();
  }
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
    // v17.11: the chosen filter + exit once more without the owner's profit lock (shows what the lock changes)
    let noLock: Row['noLock'];
    if (s.id !== 'random' && DEFAULT_SIM.profitLock) {
      const off: Trade[] = [];
      for (const se of seriesTf) {
        const sigs = sigsBy.get(se)!;
        const mapped = exit === 'designed' ? sigs : sigs.map((sg, i) => applyExit(sg, exit, se.ctx, i));
        off.push(...simulate(se.inst, tf, se.ctx, s.id, mapped, allowFor(filter, se.env, style), { ...DEFAULT_SIM, profitLock: false }));
        if (se.ctx.bars.length > 8_000) await yieldNow();
      }
      noLock = vRow(statsOf(off, o.oosFrom));
    }
    // v18 pass 3: the chosen filter + exit with a different way in (entries.ts) — graded only, never picked: the
    // bot enters at the next open until the practice account can hold a limit order
    let entryVariants: EntryVariantRow[] | undefined;
    const byEntry = new Map<EntryKind, Bucket>();
    if (s.id !== 'random') {
      entryVariants = [entryVariantRow('market', ch)];
      for (const k of ENTRIES) {
        if (k === 'market') continue;
        const b: Bucket = { trades: [], perPair: [] };
        for (const se of seriesTf) {
          const sigs = sigsBy.get(se)!;
          const mapped = exit === 'designed' ? sigs : sigs.map((sg, i) => applyExit(sg, exit, se.ctx, i));
          const ts = simulate(se.inst, tf, se.ctx, s.id, mapped, allowFor(filter, se.env, style), { ...DEFAULT_SIM, entry: k });
          b.trades.push(...ts);
          b.perPair.push({ pair: se.inst.id, ...rStats(ts) });
          if (se.ctx.bars.length > 8_000) await yieldNow();
        }
        byEntry.set(k, b);
        entryVariants.push(entryVariantRow(k, statsOf(b.trades, o.oosFrom)));
        await yieldNow();
      }
    }
    sigsBy.clear();
    // v18.4: the way in it trades with — a limit / pullback entry only once it proved better on the first 70%. The row's
    // record (and its paper trades) become that variant's; the signals on the newest bar stay market trades carrying
    // the resting order the bot should place (a limit sim can't know yet whether that order fills).
    const entry: EntryKind = s.id !== 'random' && FX_CONFIG.liveEntries && entryVariants ? chooseEntry(entryVariants, prev?.n) : 'market';
    const eb = entry !== 'market' ? byEntry.get(entry) : undefined;
    const chR = eb ? statsOf(eb.trades, o.oosFrom) : ch;
    const vR = eb ? { trades: [...eb.trades, ...v.trades.filter((t) => t.reason === 'open')], perPair: eb.perPair } : v;
    const doneR = eb ? eb.trades.filter((t) => t.reason !== 'open') : done;
    byEntry.clear();
    // v18: the financing share of the chosen variant's R (same split as statsOf)
    const finOf = (ts: readonly Trade[]) => (ts.length ? ts.reduce((a, t) => a + (t.fin ?? 0), 0) / ts.length : 0);
    const fin = s.id === 'random' ? undefined : { inAvgR: finOf(doneR.filter((t) => t.exitT < o.oosFrom)), outAvgR: finOf(doneR.filter((t) => t.entryT >= o.oosFrom)), known: doneR.some((t) => t.fin !== undefined) };
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
      ...(entry !== 'market' ? { entry } : {}),
      all: chR.all,
      inSample: chR.inSample,
      outSample: chR.outSample,
      tradesPerWeek: Math.round((doneR.length / o.weeks) * 10) / 10,
      risk: FX_CONFIG.riskLevelsPct.map((r) => equityCurve(doneR, r, FX_CONFIG.maxLeverage)),
      pairs: vR.perPair.sort((a, b) => b.totalR - a.totalR).map((x) => ({ pair: x.pair, n: x.n, winPct: x.winPct, pf: x.pf, totalR: x.totalR })) as Row['pairs'],
      verdict: 'no',
      why: '',
      ...(noLock ? { noLock } : {}),
      ...(entryVariants ? { entryVariants } : {}),
      ...(fin ? { fin } : {}),
    });
    const paper = vR.trades.filter((t) => t.entryT >= o.since);
    const pDone = paper.filter((t) => t.reason !== 'open');
    const pOpen = paper.filter((t) => t.reason === 'open');
    paperRows.push({ id: s.id, name: s.name, tf, stats: rStats(pDone), risk1: equityCurve(pDone, 1, FX_CONFIG.maxLeverage), open: pOpen.length });
    open.push(...pOpen);
    recent.push(...pDone);
    await onStrategy?.({ s, style, key, tf, filter, exit, fStats, ch: chR, trades: vR.trades, done: doneR, raw: byFilter.get('none')!.trades });
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

/** v17: the hourly refresh — at most 2 Yahoo calls at once, 500 ms apart, and no new call after `budgetMs` (a series left
 * out keeps its stored bars; the freshness check then stops new trades on it if it falls behind). */
export const REFRESH = { concurrency: 2, gapMs: 500, budgetMs: 120_000 };
export async function refreshAll(redis: Redis, cfg = REFRESH): Promise<FeedStatus[]> {
  const jobs: Array<() => Promise<FeedStatus>> = [
    ...INSTRUMENTS.map((inst) => async () => ({ ...(await refreshInstrument(redis, inst)), role: 'traded' as const })),
    ...STRENGTH_PAIRS.map((p) => async () => ({ ...(await refreshSeries(redis, p.id, p.yahoo)), role: 'strength' as const })),
    ...MOOD_SYMBOLS.map((m) => async () => ({ ...(await refreshSeries(redis, `mood:${m.id}`, m.yahoo, Date.now(), 800)), id: m.id, role: 'mood' as const })),
  ];
  const ids = [...INSTRUMENTS.map((i) => ({ id: i.id, role: 'traded' as const })), ...STRENGTH_PAIRS.map((p) => ({ id: p.id, role: 'strength' as const })), ...MOOD_SYMBOLS.map((m) => ({ id: m.id, role: 'mood' as const }))];
  const out: Array<FeedStatus | undefined> = new Array(jobs.length);
  const t0 = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const k = next++;
      if (Date.now() - t0 > cfg.budgetMs) {
        out[k] = { id: ids[k]!.id, role: ids[k]!.role, bars: 0, firstT: null, lastT: null, error: 'skipped: the refresh ran out of time (Yahoo slow)' };
        continue;
      }
      out[k] = await jobs[k]!().catch((err: Error) => ({ id: ids[k]!.id, role: ids[k]!.role, bars: 0, firstT: null, lastT: null, error: err.message }));
      if (cfg.gapMs > 0) await new Promise((r) => setTimeout(r, cfg.gapMs));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
  return out.filter((x): x is FeedStatus => !!x);
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
  /** v20: the market desks from the last run */
  desks: MarketDesk[] = [];
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
    this.learnLoaded = this.redis
      .get(FX_LEARN)
      .then((raw) => {
        if (raw && !Object.keys(this.learned).length) this.learned = (JSON.parse(raw) as { keys: Record<string, LearnKey> }).keys ?? {};
      })
      .catch(() => undefined);
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
    if (this.collectLog) {
      this.collectLog.push(...events);
      return;
    }
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

  /**
   * v17.2: the run in a child process; inline only when the child could not even start. v17: the parent's breakers go
   * along and come back merged; the learner's fork-time states are remembered (`importState` keeps the parent's when
   * they moved meanwhile); a child that started and then failed lightly (threw / its result didn't come back)
   * `LAB_WORKER.inlineAfterFails` runs in a row sends the next `LAB_WORKER.inlineRuns` runs inline (warn + a bot-log
   * line); a heavy failure (timed out / out of memory) is only skipped; a good child run clears the streak.
   */
  private async runInWorker(refresh: boolean): Promise<RunOutput | null> {
    const t0 = Date.now();
    const input: WorkerInput = { learned: this.learned, learnSig: this.learnSig, chosenSig: this.chosenSig, heatActive: this.heatNow?.active ?? null, breakers: feeds.breakerSnapshot() };
    this.forkLearnSig = input.learnSig;
    try {
      const r = await forkLabRun(refresh, input, { ...LAB_WORKER, heapMb: heapFor(this.workerStreak) });
      if (r.kind === 'spawn') {
        log.warn({ err: r.error }, 'forex lab worker could not start — running this hour inline');
        this.forkLearnSig = null;
        return await this.computeRun(refresh);
      }
      if (r.kind === 'failed') {
        // v17: the child's feed reports + breakers count even when the run failed (a Yahoo outage it hit pauses us too)
        if (r.feeds) feeds.merge(r.feeds);
        if (r.breakers) feeds.mergeBreakers(r.breakers);
        const a = afterLabRun(this.workerStreak, r.heavy ? 'heavy' : 'failed');
        this.workerStreak = a.st;
        if (r.heavy) {
          log.warn({ err: r.error, heavy: a.st.heavy }, 'forex lab worker ran out of time / memory — this hour is skipped');
          this.logBot([`hourly test skipped: its separate process ${r.error} (${a.st.heavy} in a row) — no new hourly-chart trades this hour${a.tripped ? '' : '; it gets more memory next hour'}`]);
        }
        if (a.tripped) {
          log.warn({ err: r.error, fails: a.st.fails, inlineRuns: a.st.inlineLeft }, 'forex lab worker keeps failing — the next runs go inline');
          this.logBot([`hourly test: its separate process failed ${a.st.fails} times in a row (${r.error}) — the next ${a.st.inlineLeft} runs go in the main process, then it tries the separate process again`]);
        }
        throw new Error(`lab worker: ${r.error}`);
      }
      if (this.workerStreak.fails >= LAB_WORKER.inlineAfterFails) this.logBot(['hourly test: its separate process works again']);
      this.workerStreak = afterLabRun(this.workerStreak, 'ok').st;
      feeds.merge(r.res.feeds);
      feeds.mergeBreakers(r.res.breakers);
      const t = this.importState(r.res.state);
      log.info({ ms: Date.now() - t0, heapMb: Math.round(process.memoryUsage().heapUsed / 1e6), learner: t ? 'parent' : 'child' }, 'forex lab run done in the worker');
      const out = r.res.out && t ? tightenOut(r.res.out, t) : r.res.out;
      // v17.8: an off key's signals are no longer "chosen" in the stored report either (as the inline run marks them)
      if (out && r.res.out && out.report !== r.res.out.report) await this.redis.set(FX_REPORT, JSON.stringify(out.report)).catch(() => undefined);
      // v17.8: the point-in-time chosen history gets the list the bot actually uses (the child no longer writes it)
      if (out && !out.noSync) await this.noteChosen(new Set(this.chosen));
      return out;
    } finally {
      this.forkLearnSig = null;
    }
  }

  /** v17.2 (child): carry over the parent's learner / chosen-list / heat state. */
  importWorkerInput(x: WorkerInput): void {
    this.learned = x.learned;
    this.learnSig = x.learnSig;
    this.chosenSig = x.chosenSig;
    if (x.heatActive !== null) this.heatNow = { active: x.heatActive, book: { idx: {} }, m: null };
    this.collectLog = [];
  }
  /** v17.2 (child): the state the parent's live bot needs. */
  exportState(): WorkerState {
    return {
      marketsNow: this.marketsNow,
      moodNow: this.moodNow,
      atr1h: this.atr1h,
      labOpen: this.labOpen,
      chosen: this.chosen,
      chooser: this.chooser,
      dataAge: this.dataAge,
      dropped: this.dropped,
      learned: this.learned,
      learnSig: this.learnSig,
      chosenSig: this.chosenSig,
      heat: this.heatNow ? { active: this.heatNow.active, idx: this.heatNow.book.idx, m: this.heatNow.m ? Array.from(this.heatNow.m) : null } : null,
      book: this.book,
      logs: this.collectLog ?? [],
    };
  }
  /**
   * v17.2 (parent): take the child's state. v17: the restricted learner is the one piece the parent moves too while the
   * child runs (its fast-chart checks call `botRecord`). When the parent's states changed since the fork (`forkSig`) its
   * own learner is kept, the child's "learner:" lines are dropped (the parent logged its own changes), the dropped /
   * chosen lists and the plan's open trades are tightened to it, and `fx:learn` is written again from here when the
   * child wrote its older view. Everything else is written only by the hourly run, so the child's copy is the newest.
   * Returns what was tightened (for the run's bot hand-over), null when the child's learner was taken.
   */
  importState(s: WorkerState, forkSig: string | null = this.forkLearnSig): LearnerTighten | null {
    const keepParent = learnerSource(forkSig, this.learnSig) === 'parent';
    const t = keepParent ? learnerTighten(this.learned, s.learned) : null;
    if (t) s = tightenState(s, t);
    this.marketsNow = s.marketsNow;
    this.moodNow = s.moodNow;
    this.atr1h = s.atr1h;
    this.labOpen = s.labOpen;
    this.chosen = s.chosen;
    this.chooser = s.chooser;
    this.dataAge = s.dataAge;
    this.dropped = s.dropped;
    if (!keepParent) {
      this.learned = s.learned;
      this.learnSig = s.learnSig;
    } else if (s.learnSig !== forkSig) {
      void this.redis.set(FX_LEARN, JSON.stringify({ at: Date.now(), keys: this.learned })).catch(() => undefined);
    }
    // v17.8: `chosenSig` stays the parent's: the child no longer notes the chosen list (the parent does, after this)
    if (s.heat) this.heatNow = { active: s.heat.active, book: { idx: s.heat.idx }, m: s.heat.m ? Float32Array.from(s.heat.m) : null };
    if (s.book) this.book = s.book;
    this.logBot(keepParent ? s.logs.filter((e) => !e.startsWith('learner: ')) : s.logs);
    return t;
  }
  /** v17.2: in the child, bot-log lines are collected for the parent instead of written */
  private collectLog: string[] | null = null;
  /** v17: the learner's states when the running child was forked (null = no child running) */
  private forkLearnSig: string | null = null;
  /** v17: the child's failure streak (worker flag on) */
  workerStreak: WorkerStreak = { ...NO_STREAK };

  run(refresh = true): Promise<FxReport | null> {
    if (this.running) return this.running;
    // v17: worker flag on, but the child kept failing → this run goes inline (the flag-off path) while the streak is sat out
    let viaWorker = labWorkerOn();
    if (viaWorker && planLabRun(this.workerStreak) === 'inline') {
      viaWorker = false;
      this.workerStreak = afterLabRun(this.workerStreak, 'inline').st;
    }
    this.running = (viaWorker ? this.runInWorker(refresh) : this.computeRun(refresh))
      .then(async (out) => {
        // the bot account always follows in this process (never in the child)
        if (out && !out.noSync) await this.syncFrom(out);
        return out?.report ?? null;
      })
      .then((r) => {
        this.lastError = null;
        feeds.ok('lab', { items: r?.rows.length ?? 0, asOf: r?.at ?? null });
        return r;
      })
      .catch((err: Error) => {
        // v17: a failed hourly run is logged and shown (it used to vanish)
        this.lastError = { t: Date.now(), msg: err?.message ?? String(err) };
        feeds.fail('lab', err);
        log.error({ err: this.lastError.msg }, 'forex lab run failed');
        throw err;
      })
      .finally(() => {
        this.running = null;
        void feeds.persist(this.redis, true);
      });
    return this.running;
  }
  /** v17: the last run's error (null after a good run) */
  lastError: { t: number; msg: string } | null = null;
  /** v17: data age of every traded market's hourly prices (set each run) */
  dataAge: Record<string, DataAge> = {};
  /** v17: who decides the list — the rolling picker (once proven) or the unseen-30% verdicts */
  chooser: 'rolling' | 'verdict' = 'verdict';
  /** v18.9: always-on rows already logged as resting (one line per rest) */
  private pausedNoted = new Set<string>();
  /** v17: the correlated-risk cap for the live bot (null until the first run) */
  heatNow: HeatLive | null = null;
  /** v18: the quant desk's latest report (what it would hold today) */
  deskNow: DeskOut | null = null;

  /** v17 luck meter: recompute on weekends when stale, then downgrade Edge / Maybe rows that random timing matches. */
  private async applyLuck(rows: Row[], series: readonly Series[], oosFrom: number, now = Date.now()): Promise<void> {
    let store: LuckStore | null = null;
    try {
      store = JSON.parse((await this.redis.get(FX_LUCK)) ?? 'null') as LuckStore | null;
    } catch {
      store = null;
    }
    const stale = !store || now - store.at > 6 * 86_400_000 || Math.abs(store.oosFrom - oosFrom) > 14 * 86_400_000;
    if (stale && !marketClock(now).open) {
      const t0 = Date.now();
      const out: LuckStore = { at: now, oosFrom, rows: {} };
      for (const tf of FX_CONFIG.timeframes) {
        const rnd = rows.find((r) => r.id === 'random' && r.tf === tf);
        const ss = series.filter((se) => se.tf === tf);
        for (const r of rows) {
          if (r.tf !== tf || r.id === 'random' || r.verdict === 'no') continue;
          const s = strategyById(r.id);
          if (!s) continue;
          const l = await luckFor(s, ss, { filter: r.filter, exit: r.exit, oosFrom, realOutAvgR: r.outSample.avgR, randomAvgR: rnd ? rnd.all.avgR : null, verdict: verdictFor }).catch(() => null);
          if (l) out.rows[`${r.id}:${tf}`] = { variant: `${r.filter}|${r.exit}`, twins: l.twins.map((x) => Math.round(x * 1000) / 1000), twinsP90: Math.round(l.twinsP90 * 1000) / 1000, pctl: l.pctl, twinPassPct: l.twinPassPct };
        }
      }
      store = out;
      await this.redis.set(FX_LUCK, JSON.stringify(out)).catch(() => undefined);
      log.info({ rows: Object.keys(out.rows).length, ms: Date.now() - t0 }, 'forex luck meter done');
    }
    // a result from another 70/30 line or older than two weeks no longer describes these rows
    if (!store || now - store.at > 14 * 86_400_000 || Math.abs(store.oosFrom - oosFrom) > 14 * 86_400_000) return;
    for (const r of rows) {
      const l = store.rows[`${r.id}:${r.tf}`];
      if (!l || l.variant !== `${r.filter}|${r.exit}`) continue;
      r.luck = { pctl: l.pctl, twinsP90: l.twinsP90, twinPassPct: l.twinPassPct };
      const d = luckDowngrade(r.verdict, r.outSample.avgR, l);
      if (d.why) {
        r.verdict = d.verdict;
        r.why = d.why;
      }
    }
  }

  /** v17: append the chosen list to `fx:chosen:hist` when it changed (500 changes kept) — what the bot could trade, when. */
  private async noteChosen(chosen: ReadonlySet<string>): Promise<void> {
    // v17.8: a run in the child leaves it to the parent, which notes the list after its own learner had its say
    // (`runInWorker`): the child's list may still hold a key the parent switched off meanwhile
    if (this.collectLog) return;
    const keys = [...chosen].sort();
    const sig = keys.join(',');
    if (sig === this.chosenSig) return;
    this.chosenSig = sig;
    try {
      await this.redis.lpush(FX_CHOSEN_HIST, JSON.stringify({ t: Date.now(), chooser: this.chooser, keys }));
      await this.redis.ltrim(FX_CHOSEN_HIST, 0, 499);
    } catch {
      // a history line is not worth failing the run for
    }
  }
  chosenSig = '';

  /**
   * The bot's per strategy:chart record: losers (12+ trades, net loss) are dropped, winners sized a bit up. v17: plus the
   * restricted learner on the R ledger — it can switch a key off or halve it, never switch on or size up.
   */
  async botRecord(): Promise<{ dropped: string[]; proven: Set<string>; down: Record<string, number>; learned: Record<string, LearnKey> }> {
    const res = this.practice ? await this.practice.botResults().catch(() => ({} as Record<string, { n: number; pnlUsd: number }>)) : {};
    const dropped = Object.entries(res).filter(([, v]) => v.n >= 12 && v.pnlUsd < 0).map(([k]) => k);
    const proven = new Set(Object.entries(res).filter(([, v]) => v.n >= 12 && v.pnlUsd > 0).map(([k]) => k));
    const down: Record<string, number> = {};
    // the learner's states from before a restart must be in place first (else a switched-off key comes back too early)
    await this.learnLoaded;
    let learned: Record<string, LearnKey> = this.learned;
    if (this.practice) {
      const practice = this.practice;
      const rows = await Promise.resolve()
        .then(() => practice.botLedger())
        .catch(() => null);
      if (rows) {
        learned = learnFromLedger(rows, Date.now(), this.learned);
        const sig = JSON.stringify(Object.entries(learned).map(([k, v]) => [k, v.state]));
        if (sig !== this.learnSig) {
          this.learnSig = sig;
          for (const [k, v] of Object.entries(learned)) if (v.state !== (this.learned[k]?.state ?? 'on')) this.logBot([`learner: ${k} → ${v.why}`]);
          void this.redis.set(FX_LEARN, JSON.stringify({ at: Date.now(), keys: learned })).catch(() => undefined);
        }
        this.learned = learned;
      }
    }
    for (const [k, v] of Object.entries(learned)) {
      if (v.state === 'off' && !dropped.includes(k)) dropped.push(k);
      if (v.state === 'down') down[k] = v.sizeF;
      if (v.state !== 'on') proven.delete(k);
    }
    return { dropped, proven, down, learned };
  }
  /** v17: the restricted learner's last view per strategy:chart (loaded from `fx:learn` at start) */
  learned: Record<string, LearnKey> = {};
  private learnLoaded: Promise<unknown> = Promise.resolve();
  learnSig = '';

  /** v17.2: everything of an hourly run except the bot sync (runs inline, or in a child process — `lab-worker.ts`). */
  async computeRun(refresh: boolean): Promise<RunOutput | null> {
    const t0 = Date.now();
    const feed: FeedStatus[] = [];
    if (refresh) feed.push(...(await refreshAll(this.redis)));
    const since = await paperSince(this.redis, FX_PAPER_SINCE, Date.now());

    // ── market read: strength (traded FX + crosses), mood ──
    const h1ById = new Map<string, Bar[]>();
    // v16: Dukascopy's older bars in front of Yahoo's (FX only, when the seam lines up) → years more history to test on
    const nowT = Date.now();
    // v17: currency pairs whose Yahoo candles fell behind (or are thin) get Dukascopy's newest hours, then gaps are filled
    // where the two sources agree (fill.ts; metals never — futures vs spot)
    const yahooById = new Map<string, Bar[]>();
    for (const id of [...INSTRUMENTS.map((i) => i.id), ...STRENGTH_PAIRS.map((p) => p.id)]) yahooById.set(id, await loadBars(this.redis, id));
    const lagging = [...yahooById].filter(([id, b]) => !id.startsWith('XA') && (b.length < FILL.bootstrapBars || (marketClock(nowT).open && dataAgeOf(id, '1h', b, nowT, HOUR).status === 'stale'))).map(([id]) => id);
    if (lagging.length) {
      const tail = await refreshDkTail(this.redis, lagging, nowT).catch(() => ({}));
      log.info({ lagging, tail }, 'forex: Yahoo behind on some markets, Dukascopy tail fetched');
    }
    const fillInfo: Record<string, { source: FillResult['source']; filled: number }> = {};
    const filledBars = async (id: string) => {
      const dk = await loadDk(this.redis, id);
      const f = fillFromDk(id, yahooById.get(id) ?? [], dk, nowT);
      fillInfo[id] = { source: f.source, filled: f.filled.length };
      return stitchHistory(id, f.bars, dk, nowT);
    };
    for (const inst of INSTRUMENTS) h1ById.set(inst.id, await filledBars(inst.id));
    // v17: how many hourly candles behind each market is (a lagging feed → no new bot trades on that market)
    this.dataAge = Object.fromEntries(INSTRUMENTS.map((inst) => [inst.id, { ...dataAgeOf(inst.id, '1h', h1ById.get(inst.id) ?? [], nowT, HOUR), ...(fillInfo[inst.id] ?? {}) }]));
    const strengthInput: Record<string, Bar[]> = {};
    for (const inst of INSTRUMENTS) if (inst.kind === 'fx') strengthInput[inst.id] = h1ById.get(inst.id)!;
    for (const p of STRENGTH_PAIRS) {
      const b = await filledBars(p.id);
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
      // v17: price stretch (how far each currency has run vs its own last 2 years) — the no-feed positioning stand-in
      stretch: buildStretch(strengthInput),
    };
    this.book = book;
    // v17: how the markets move together (EWMA correlations of hourly returns, a snapshot each 22:00 UTC) for the heat cap
    const corr = buildCorrBook(h1ById, INSTRUMENTS.map((i) => i.id));
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
      return { report: empty, botTrades: [], pairsSeen: [], chosen: [], dropped: [], firing: { signals: 0, chosen: 0 }, noSync: true };
    }
    const oosFrom = from + (1 - FX_CONFIG.oosFraction) * (to - from);
    // v17.8: last hour's picks only while the 70/30 line hasn't moved back (`prevPicks`); the old unstamped format is
    // ignored once (one re-pick after the deploy)
    const rawChosen = await this.redis.get(FX_FILTERS_CHOSEN).catch(() => null);
    const prevChosen: Record<string, { f?: FilterKind; e?: ExitKind; n?: EntryKind }> = Object.assign({}, ...FX_CONFIG.timeframes.map((tf) => prevPicks(rawChosen, tf, oosFrom)));
    const rows: Row[] = [];
    const paperRows: PaperRow[] = [];
    const open: Trade[] = [];
    const recent: Trade[] = [];
    /** unseen trades of the strategies the whole-bot test picks (new = with filters + exits, old = raw) */
    /** v17 rolling picker: every row's closed trades, and its unseen ones (after the 1-week gap) for the weekly re-pick test */
    const rollRows: RollRow[] = [];
    const rollOos = new Map<string, RollTrade[]>();
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
    /** v18: every row's closed trades (final variant) for the honest statistics */
    const statInputs: StatInput[] = [];
    for (const tf of FX_CONFIG.timeframes) {
      const ev = await evaluateTf(series.filter((se) => se.tf === tf), tf, { oosFrom, since, weeks, prev: prevChosen }, (x) => {
        statInputs.push({ key: x.key, isRandom: x.s.id === 'random', done: x.done });
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
        // v17 rolling picker: the row as it is traded (chosen filter + exit)
        rollRows.push(rollRow(x.key, x.done, always));
        rollOos.set(
          x.key,
          x.done.filter((t) => t.entryT >= oosFrom + ROLL.embargoDays * 86_400_000).map((t) => ({ pair: t.pair, side: t.side, entryT: t.entryT, ...(t.keyT !== undefined ? { keyT: t.keyT } : {}), exitT: t.exitT, r: t.r, stopPct: t.stopPct, strategy: t.strategy, tf: t.tf, sizeF: 1, vf: volFactor(t.volRatio) })),
        );
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
    // ── v17 luck meter: an Edge / Maybe row must beat 90% of 20 copies that keep its exits but fire at random times.
    //    Heavy (≈ 0.4–2.5 s a row), so it runs on weekends only; the stored result is applied every hour while the row
    //    still trades the same filter + exit ──
    await this.applyLuck(rows, series, oosFrom);
    // ── v18 honest statistics: deflated Sharpe per row (Edge needs ≥ 50%), PBO + Reality Check / SPA overall ──
    let honest: HonestReport | undefined;
    try {
      const h = honestStats(statInputs, { from, to, oosFrom });
      let downgraded = 0;
      for (const r of rows) {
        const st = h.rows.get(`${r.id}:${r.tf}`);
        if (st) r.stats = st;
        const d = dsrDowngrade(r.verdict, st, h.report.trials);
        if (d.why) {
          r.verdict = d.verdict;
          r.why = d.why;
          downgraded++;
        }
      }
      honest = { ...h.report, downgraded };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'honest statistics failed');
    }
    // v20.4: the quality bar (after the luck meter; the deflated Sharpe is reported, not required)
    for (const r of rows) {
      const rnd = rows.find((x) => x.id === 'random' && x.tf === r.tf);
      r.quality = qualityPass(r, rnd ? rnd.all.avgR : null);
    }
    statInputs.length = 0;
    await yieldNow();
    const filters = summarizeFilters(rows);
    const exits = summarizeExits(rows);
    const entries = summarizeEntries(rows);
    const financing = summarizeFinancing(rows);
    const lockSummary = summarizeLock(rows, DEFAULT_SIM.profitLock);
    const chosenStore: ChosenStore = { oosFrom, picks: Object.fromEntries(rows.map((r) => [`${r.id}:${r.tf}`, { f: r.filter, e: r.exit, n: r.entry ?? 'market' }])) };
    await this.redis.set(FX_FILTERS_CHOSEN, JSON.stringify(chosenStore)).catch(() => undefined);

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
    // v17: the main model's own scores only (the tiers are graded on them); one it can't score is dropped, never a 0
    const pOf = (x: Float64Array | undefined) => (judgeModel && x ? judgeMainP(judgeModel, x) : null);
    const cuts = judgeModel ? judgeCuts(judgeScores(judgeModel, convPend.filter((c) => c.exitT < oosFrom).map((c) => c.x))) : { pHi: null, pTop: null };
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
    let heated: PortfolioResult | null = null;
    let heatGrade: HeatGrade = { active: false, why: 'not graded yet' };
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
              // v17.8: the main judge alone — the backup was picked on these same unseen trades
              return !x || judgeKeeps(judgeModel!, x, { backup: false });
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
      // v17: the same bot with the correlated-risk cap (trades that move together count as one bet)
      const plain1 = levels.find((l) => l.baseRiskPct === 1) ?? null;
      heated = simulatePortfolio(poolNew, { ...base, ...upgraded, label: 'with the correlated-risk cap', baseRiskPct: 1, heat: { capPct: RISK_MODES.normal.heatCapPct, book: corr, minScale: HEAT.minScale } });
      heatGrade = gradeHeat(heated, plain1, this.heatNow?.active ?? (await this.redis.get(FX_HEAT).then((x) => !!(x && (JSON.parse(x) as { active?: boolean }).active)).catch(() => false)));
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
        heated,
        heatWhy: heatGrade.why,
        note: `Strategies, their checks and their exits were picked on the first 70% of the history only; this is what the whole bot would have done on the last 30%, which it never saw: real spreads, max ${SIZING.maxOpen} trades at once (${SIZING.maxPerStrategy} per strategy), ${SIZING.leverage}× margin, the currency limit and the sizing rules.`,
      };
      await this.redis.set(FX_PORTFOLIO, JSON.stringify(portfolio)).catch(() => undefined);
    }
    wfPool.length = 0;
    // v17: the correlated-risk cap the live bot uses (the latest correlations; on only once graded above)
    this.heatNow = { active: heatGrade.active, book: { idx: corr.idx }, m: corr.now };
    await this.redis.set(FX_HEAT, JSON.stringify({ at: Date.now(), active: heatGrade.active, why: heatGrade.why, matrix: roundedMatrix(corr) })).catch(() => undefined);
    await yieldNow();

    // ── v17 rolling picker: re-picks the rows every week from their last 26 weeks; graded on the unseen weeks vs random pickers ──
    let rolling: RollReport | null = null;
    let rollKeys: string[] | null = null;
    let rollSizes: Record<string, number> = {};
    try {
      const sim = { maxOpen: SIZING.maxOpen, leverage: SIZING.leverage, marginShare: SIZING.marginShare, baseRiskPct: 1, maxPerStrategy: SIZING.maxPerStrategy, prioritise: true, ccyCapPct: SIZING.ccyCapPct, ddSizing: true, flatSizing: false };
      const { w0, w1 } = rollWeeks(oosFrom, to);
      const nk = nullKey(rollRows, w0, w1);
      let nul: NullStats | null = null;
      try {
        const c = JSON.parse((await this.redis.get(FX_ROLL_NULL)) ?? 'null') as { key: string; nul: NullStats } | null;
        if (c?.key === nk) nul = c.nul;
      } catch {
        nul = null;
      }
      if (!nul && w1 - w0 + 1 >= ROLL.minGradedWeeks) {
        // the random pickers: recomputed about once a week (when the graded weeks move)
        const tn = Date.now();
        nul = await randomPickerNull(rollRows, rollOos, w0, w1, sim, ROLL.nullDraws, ROLL.seed, yieldNow);
        log.info({ ms: Date.now() - tn, draws: ROLL.nullDraws }, 'forex random pickers built');
        await this.redis.set(FX_ROLL_NULL, JSON.stringify({ key: nk, nul })).catch(() => undefined);
      }
      const prevRoll = JSON.parse((await this.redis.get(FX_ROLL_PICKS).catch(() => null)) ?? 'null') as RollPicksState | null;
      const nowW = weekOf(Date.now());
      rolling = gradeRolling(rollRows, rollOos, { oosFrom, to, now: Date.now(), sim, staticPool: poolNew, nul, wasActive: !!prevRoll?.active, prevKeys: prevRoll ? (prevRoll.week === nowW ? prevRoll.prevKeys : prevRoll.keys) : null });
      // the same week keeps its list (a mid-week filter / exit change doesn't flip it); a new week re-picks
      const have = new Set(rollRows.map((r) => r.key));
      const same = prevRoll && prevRoll.week === nowW;
      rollKeys = same ? prevRoll.keys.filter((k) => have.has(k)) : rolling.thisWeek.picks.map((p) => p.key);
      // the week's sizes are frozen with its list (a mid-week change can't fall back to another rule's size)
      rollSizes = same && prevRoll.sizes ? prevRoll.sizes : Object.fromEntries(rolling.thisWeek.picks.map((p) => [p.key, p.sizeF]));
      const st: RollPicksState = { week: nowW, keys: rollKeys, sizes: rollSizes, active: rolling.active, prevKeys: same ? prevRoll.prevKeys : prevRoll?.keys ?? null };
      await this.redis.set(FX_ROLL_PICKS, JSON.stringify(st)).catch(() => undefined);
      await this.redis.set(FX_ROLL, JSON.stringify(rolling)).catch(() => undefined);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'rolling picker failed');
    }
    rollRows.length = 0;
    rollOos.clear();
    await yieldNow();

    // ── what the bot trades: the rolling picker's list once it proved itself, else Edge / Maybe on unseen data + the
    //    published four; minus what lost in its own account ──
    const rec = await this.botRecord();
    this.dropped = rec.dropped;
    const rollLive = rolling?.active && rollKeys ? new Set(rollKeys) : null;

    // v18.9: an always-on row rests while its own last 26 weeks lose money (the rolling picker's record, same rule live)
    const alwaysOff = new Set((rolling?.thisWeek.paused ?? []).map((p) => p.key));
    const mode = FX_CONFIG.strict.mode;
    const strict = mode !== 'off';
    const chosenRows = rows.filter((x) => x.id !== 'random' && !rec.dropped.includes(`${x.id}:${x.tf}`) && (mode === 'edge' ? x.verdict === 'edge' : mode === 'quality' ? !!x.quality?.ok : rollLive ? rollLive.has(`${x.id}:${x.tf}`) : x.verdict !== 'no' || (FX_CONFIG.botAlways.includes(x.id) && !alwaysOff.has(`${x.id}:${x.tf}`))));
    // v20.1 strict mode: say once per hour-of-change why the list is empty (the owner reads the Decisions log)
    if (strict && !chosenRows.length && this.chosen.length) this.logBot([mode === 'edge' ? 'strict mode: no strategy has passed the unseen exam right now — the bot waits (nothing is traded until one earns Edge)' : 'strict mode: no strategy clears the quality bar right now — the bot waits']);
    for (const p of rolling?.thisWeek.paused ?? []) {
      const k = `${p.key}:paused`;
      if (!this.pausedNoted.has(k)) {
        this.pausedNoted.add(k);
        this.logBot([`${p.key} (always on) rests: its last 26 weeks lost money (${p.n} trades, profit factor ${p.pf ?? '—'})`]);
      }
    }
    for (const k of [...this.pausedNoted]) if (!alwaysOff.has(k.replace(/:paused$/, ''))) this.pausedNoted.delete(k);
    const chosen = new Set(chosenRows.map((x) => `${x.id}:${x.tf}`));
    this.chosen = [...chosen];
    this.chooser = strict ? 'verdict' : rollLive ? 'rolling' : 'verdict';
    // v17: a point-in-time record of what the bot was allowed to trade (only when the list changes)
    await this.noteChosen(chosen);

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

    // ── v18 the quant desk: continuous forecasts on daily closes, vol-targeted, graded on the unseen 30% ──
    let desk: DeskOut | null = null;
    try {
      desk = deskFromBars(h1ById, book.macro ?? null, oosFrom, 1000);
      if (desk) await this.redis.set(FX_DESK, JSON.stringify(desk)).catch(() => undefined);
      this.deskNow = desk;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'quant desk failed');
    }
    await yieldNow();

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
      entries,
      financing,
      lock: lockSummary,
      judge,
      portfolio,
      news,
      conviction,
      sniper,
      ...(honest ? { honest } : {}),
      desk,
      dataAge: Object.values(this.dataAge),
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
    const rowOf = new Map(chosenRows.map((x) => [`${x.id}:${x.tf}`, x]));
    // v17: how often each filter input was known on the first 70% of each series (for `missingInput`)
    const covCache = new Map<Series, ReturnType<typeof filterCoverage>>();
    const coverageOf = (se: Series) => {
      let c = covCache.get(se);
      if (!c) {
        const upTo = se.ctx.bars.findIndex((b) => b.t >= oosFrom);
        c = se.env ? filterCoverage(se.env, upTo < 0 ? se.ctx.bars.length : upTo) : {};
        covCache.set(se, c);
      }
      return c;
    };
    // what the bot account is handed (built here so a child process can hand it to the parent: v17.2)
    const botTrades: LabOpenTrade[] = open.map((t) => {
      const row = rowOf.get(`${t.strategy}:${t.tf}`);
      const sizeF = (rollLive ? rollSizes[`${t.strategy}:${t.tf}`] ?? 0.6 : row ? stratFactorFromVerdict(row.verdict) : 1) * volFactor(t.volRatio) * (rec.proven.has(`${t.strategy}:${t.tf}`) ? 1.15 : 1) * (rec.down[`${t.strategy}:${t.tf}`] ?? 1);
      const x = judgeX.get(tradeKey(t));
      const jv = judgeModel && x ? judgeView(judgeModel, x) : null;
      const p = jv?.p ?? null;
      // v17: an active judge that can't score a signal (a reading it relies on is missing now) → the trade waits;
      // a score from the backup model is held to the backup's own bar (jv.threshold)
      const judgeOk = !judge?.active || !judgeModel || !jv || (jv.p !== null && jv.p >= jv.threshold);
      // v17: conviction cut points are the main model's, so only its own score counts there
      const conf = confirmations(openAgree.get(tradeKey(t)) ?? 0, jv?.via === 'main' ? p : null, cuts);
      const b = boostFor(tierOf(conf, hasJudge), conviction);
      // v17: the row's filter has no data at the signal bar right now (it had in the tested history) → wait
      const se = seriesOf.get(`${t.pair}:${t.tf}`);
      const si = se ? signalIndex(se.ctx.bars, t.entryT, se.ctx.barMin) : -1;
      const dataWait = se && si >= 0 && row ? missingInput(row.filter, se.env, si, coverageOf(se)) : null;
      // v18.4: the strategy's tested way in is a resting order → where it sits and how long it lives (bars after the signal)
      const order = ((): LabOpenTrade['order'] => {
        if (!row?.entry || row.entry === 'market' || row.entry === 'confirm' || !se || si < 0) return null;
        const b = se.ctx.bars[si]!;
        const atr = se.ctx.atr14[si]!;
        const back = row.entry === 'pullback' ? ENTRY.pullbackAtr * (Number.isFinite(atr) && atr > 0 ? atr : 0) : 0;
        const limit = b.c - t.side * back;
        if (t.side === 1 ? limit <= t.stop : limit >= t.stop) return null;
        const barMs = se.ctx.barMin * 60_000;
        return { kind: row.entry, limit, until: b.t + barMs * (1 + (row.entry === 'limit' ? ENTRY.limitBars : ENTRY.pullbackBars)) };
      })();
      // v20.1: how many market checks stand behind the trade at its signal close (strict mode needs `need` of them)
      const agree = { n: openAgree.get(tradeKey(t)) ?? 0, of: maxConfirmations(t.tf, false), need: FX_CONFIG.strict.minAgree };
      // v20.4: the strategy's own tested record on THIS market — no winning record here → the trade waits
      const marketRec = ((): LabOpenTrade['marketRec'] => {
        if (!strict || !row) return null;
        const pr = row.pairs.find((x) => x.pair === t.pair);
        const m = FX_CONFIG.strict.market;
        if (!pr) return { n: 0, pf: null, totalR: 0, ok: false };
        return { n: pr.n, pf: pr.pf, totalR: pr.totalR, ok: pr.n >= m.minN && (pr.pf ?? 99) >= m.minPf && pr.totalR > 0 };
      })();
      return toLabTrade(t, {
        order,
        agree,
        marketRec,
        chosen: chosen.has(`${t.strategy}:${t.tf}`),
        sizeF,
        prio: row ? row.all.avgR : -1,
        dataWait,
        judge: !jv ? null : { p: p === null ? 0 : Math.round(p * 100) / 100, ok: judgeOk, need: Number.isFinite(jv.threshold) ? Math.round(jv.threshold * 100) / 100 : null, ...(jv.missing ? { missing: jv.missing } : {}) },
        conviction: { tier: b.tier, conf, of: maxConfirmations(t.tf, hasJudge), mult: b.mult, lev: b.lev },
        sniper: (() => {
          const ex = openExtra.get(tradeKey(t));
          if (!ex) return null;
          const votes = conf + ex.total;
          return { votes, of: maxConfirmations(t.tf, hasJudge) + ex.of, k: sniper.k, on: sniper.active && sniper.k !== null && votes >= sniper.k, yes: ex.yes };
        })(),
      });
    });
    const firing = markets.flatMap((m) => m.firing);
    const out: RunOutput = {
      report,
      botTrades,
      pairsSeen: series.filter((se) => se.tf === '1h' && se.ctx.bars.length && se.ctx.bars[se.ctx.bars.length - 1]!.t + 4 * 3_600_000 >= Date.now()).map((se) => se.inst.id),
      chosen: [...chosen],
      dropped: rec.dropped,
      firing: { signals: firing.length, chosen: firing.filter((f) => f.chosen && f.allowed).length },
    };
    log.info({ rows: rows.length, edges, filtered, ms: report.durationMs, heapMb: Math.round(process.memoryUsage().heapUsed / 1e6), rssMb: Math.round(process.memoryUsage().rss / 1e6), worker: !!this.collectLog }, 'forex lab run done');
    return out;
  }

  /** The bot account follows the run: opens / manages / closes its trades (always in this process). */
  async syncFrom(out: RunOutput): Promise<void> {
    // v18: the practice accounts book overnight financing from the same policy rates the lab tests with
    if (this.practice) this.practice.carryFor = (pair, t) => carryAt(this.book?.macro ?? null, pair, t);
    if (!this.practice) return;
    // v20: every market's desk ranks its strategies on that market (lab record + the bot's own fills) and, where the
    // market has had no trade today, takes its best firing arm as a half-size learning trade
    try {
      const snap = await this.practice.snapshot('bot');
      const built = buildDesks({
        now: Date.now(),
        markets: INSTRUMENTS.map((i) => i.id),
        rows: out.report.rows.map((r) => ({ id: r.id, tf: r.tf, pairs: r.pairs })),
        ledger: ledgerRows(snap.account),
        positions: snap.account.positions,
        closed: snap.account.closed,
        open: out.botTrades,
        chosen: new Set(out.chosen),
        quota: FX_CONFIG.strict.deskTrades ? undefined : 0,
      });
      const n = FX_CONFIG.strict.deskTrades ? applyDesks(out.botTrades, built.picks) : 0;
      this.desks = built.desks;
      if (n) this.logBot(built.desks.filter((d) => d.pick).map((d) => `desk: ${d.pick!.why}`));
      await this.redis.set(FX_DESKS, JSON.stringify({ at: Date.now(), desks: built.desks })).catch(() => undefined);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'forex market desks failed');
    }
    const sync = newSyncReport();
    const ev = await this.practice
      .syncBot(
        out.botTrades,
        (pair) => staleReason(this.dataAge[pair], Date.now()) ?? this.calendar?.blockFor(pair) ?? this.headlines?.blockFor(pair) ?? null,
        this.atr1h,
        // v17: a held trade on a market with no fresh hourly candles this run is kept (the lab couldn't see it end)
        { scope: FX_CONFIG.timeframes, report: sync, heat: this.heatNow, pairsSeen: new Set(out.pairsSeen) },
      )
      .catch((err: Error) => [`bot sync failed: ${err.message}`]);
    this.lastSync['1h'] = sync;
    this.logBot(ev);
    this.noteRun({ t: Date.now(), tf: '1h', signals: out.firing.signals, chosen: out.firing.chosen, opened: sync.opened, skipped: sync.skipped.length, waits: sync.waits.length, holding: sync.heldOpen + sync.opened });
    await this.redis.set('fx:bot:chosen', JSON.stringify(out.chosen)).catch(() => undefined);
    await this.redis.set('fx:bot:dropped', JSON.stringify(out.dropped)).catch(() => undefined);
  }
}
