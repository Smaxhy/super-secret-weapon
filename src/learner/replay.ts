/**
 * Replay engine (v11.5): the bot's entry rules + exits run over the recorded market (Postgres `TradeTape`, written by
 * learner/tape-recorder.ts) — "with these rules, what would the last days have made?" in minutes instead of weeks.
 * `npm run replay -- --from 2026-10-17 --to 2026-10-18 [--policy live|sniper] [--set key=value]`, or Performance →
 * Tests → Replay. Pure engine: feed it tape rows in time order (replay-cli.ts streams them from the database).
 *
 * REPLAYED from the tape alone: price / market cap (pool price × 1B supply), volume, distinct buyers (holders ≈
 * wallets still net long), fees (≈1% of volume), coin age (Token.createdAt), curve % (curve trades carry it),
 * migration (first PumpSwap trade / Token.completedAt), the owner's terminal filters (owner-filters.ts), the per-
 * strategy minimums (fees by MC, MC, volume, curve window, BOOST wait, the migrated organic-flow scan), new-pair
 * demand + absorption (new-pair.ts), staircase charts, the momentum gate, entry quality, buyer/seller pressure, the
 * score bar (a tape score from the scorer's tape-computable features; where the bot really evaluated the coin within
 * ±2 min its stored score + safety verdict are used instead) and every exit through VirtualBook → decideExit with
 * paper costs (time stops, tiers, trail, spike sell, dead coin, max hold; early bail + no-life need live buy/sell flow and do NOT fire in a replay).
 *
 * NOT replayed (neutral): RPC-only safety checks (mint / freeze authority, holder lists, dev wallet, bundle guard,
 * funding graph, rugger memory), socials / narrative / X, KOL + copy wallets, RugCheck, trending lists, the dip
 * watcher (a stretched signal is bought at the next checkpoint instead of after a dip), the 15 s confirmation wait,
 * learning trades / probes, and chart-reading exits (CPU). A replay is therefore optimistic on rugs and pessimistic
 * on dip timing: compare policies against each other on the same days rather than reading one number as gospel.
 */
import { DEFAULT_CONFIG } from '../config/default';
import { sniperEntryFails } from '../evaluator/sniper';
import { getConfig, getWeights } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import { DEFAULT_ENTRY_QUALITY, entryQuality } from '../evaluator/entry-quality';
import { momentumGateFails } from '../evaluator/momentum-gate';
import { computeEarlyFlow, newPairCheck } from '../evaluator/new-pair';
import { flowPressure, ownerFilterFails, pressureFail } from '../evaluator/owner-filters';
import { priceShape, staircase, type PriceShape } from '../evaluator/price-shape';
import { feeMinimum, scoreFeatures, type FeatureVector } from '../evaluator/scorer';
import { candlesFromTrades } from '../evaluator/timeframes';
import type { CrowdTracker, CrowdTrade } from '../scanner/crowd-tracker';
import { organicFlow, type OrganicFlow } from '../scanner/migrated-scanner';
import { VirtualBook, type VirtualResult } from './virtual-book';
import { crowdQuality } from '../evaluator/crowd-quality';
import { watchedHolders } from '../executor/holder-clock';
import { walletBookConfig, type WalletBook } from './wallet-book';
import type { DeployerBook, DeployerView } from './deployer-book';

export interface TapeRow {
  mint: string;
  t: number;
  w: string;
  buy: boolean;
  sol: number;
  tok: number;
  px: number;
  pp?: number;
  s?: number;
  amm: boolean;
  curvePct?: number | null;
}

export interface TapeToken {
  mint: string;
  name: string;
  symbol: string;
  creator: string | null;
  createdAtMs: number | null;
  completedAtMs: number | null;
}

/** What the bot really decided about a coin at the time (Evaluation row) — fills the gates the tape can't. */
export interface StoredEval {
  tMs: number;
  score: number;
  safetyScore: number;
  hardFail: boolean;
}

export interface EntryContext {
  mint: string;
  symbol: string;
  strategy: StrategyName;
  now: number;
  trades: readonly CrowdTrade[];
  priceSol: number;
  mcUsd: number;
  ageSec: number;
  flow: OrganicFlow | null;
  shape: PriceShape | null;
  score: number;
  threshold: number;
  fails: readonly string[];
}

export interface ReplayPolicy {
  name: string;
  /** Config patch applied before the run (deep-merged over the live config) — exits, sizes, rule limits. */
  overrides?: Record<string, unknown>;
  /** Extra entry rule on top of the live ones: string = why not. */
  entry?: (ctx: EntryContext) => string | null;
}

export interface ReplayOptions {
  policy: ReplayPolicy;
  tokens: Map<string, TapeToken>;
  evals?: Map<string, StoredEval[]>;
  solUsd: number;
  from: number;
  to: number;
  /** v11.6: the wallet book fed from the tape (seeded from the live book when available) — crowd quality + holder clock. */
  book?: WalletBook | null;
  /** v11.10: the deployer book (seeded from the live records, read-only) — the creator's record as an entry rule. */
  deployers?: DeployerBook | null;
}

export interface ReplayTrade {
  mint: string;
  symbol: string;
  strategy: StrategyName;
  openedAt: string;
  pnlPct: number;
  pnlSol: number;
  peakX: number;
  holdSec: number;
  reason: string;
  score: number;
}

export interface ReplayReport {
  id: string;
  at: string;
  from: string;
  to: string;
  policy: string;
  overrides: Record<string, unknown>;
  rows: number;
  coins: number;
  evaluated: number;
  signals: number;
  trades: number;
  winRatePct: number;
  totalSol: number;
  avgPct: number;
  medianPct: number;
  profitFactor: number | null;
  sizeSol: number;
  byStrategy: Array<{ strategy: string; n: number; winRatePct: number; totalSol: number; avgPct: number }>;
  byExit: Array<{ reason: string; n: number; totalSol: number; avgPct: number }>;
  skips: Array<{ reason: string; count: number }>;
  worst: ReplayTrade[];
  best: ReplayTrade[];
  durationMs: number;
  note: string;
}

interface Coin {
  mint: string;
  trades: CrowdTrade[];
  firstT: number;
  lastT: number;
  amm: boolean;
  ammSinceT: number | null;
  curvePct: number | null;
  soonAt: number | null;
  nextCurveIdx: number;
  nextSoonIdx: number;
  nextMigAt: number;
  /** Net whole tokens per wallet (> 0 = still holding). */
  net: Map<string, number>;
  volumeSol: number;
  netSol: number;
  lastBuyAt: number;
}

const CURVE_CHECKPOINTS = [45, 60, 90, 120, 180, 240, 300, 420, 600, 720];
const KEEP_MS = 25 * 60_000;
const SUPPLY = 1e9;
const EVAL_MATCH_MS = 120_000;
const REBUY_MS = 30 * 60_000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const REPLAY_NOTE =
  'Not replayed (neutral): RPC safety checks, holder / dev / bundle guards, socials, KOLs, RugCheck, trending lists, the dip wait and the 15 s confirmation. Optimistic on rugs, pessimistic on dip timing — compare policies on the same days.';

/** Sniper mode as a replay policy: exactly the live switch (exit overlay + entry gate + conviction size). */
export function sniperPolicy(): ReplayPolicy {
  const cfg = getConfig();
  return { name: 'sniper', overrides: { sniper: { enabled: true }, trading: { maxPositionSol: cfg.trading.highConviction?.sizeSol ?? 1 } } };
}

export function policyByName(name: string): ReplayPolicy {
  if (name === 'sniper') return sniperPolicy();
  // live rules + the wallet engine on (with `wallets.enabled` saved as true, `live` is the same; `--set wallets.enabled=false` shows the difference)
  if (name === 'wallets') return { name: 'wallets', overrides: { wallets: { enabled: true, entry: { enabled: true } }, exit: { holderClock: { enabled: true } } } };
  return { name: 'live' };
}

export class Replay {
  private readonly coins = new Map<string, Coin>();
  private readonly book: VirtualBook;
  private readonly results: Array<VirtualResult & { sizeSol: number }> = [];
  private readonly openBy = new Map<string, number>();
  private readonly skips = new Map<string, number>();
  private readonly sizeSol: number;
  private rows = 0;
  private evaluated = 0;
  private signals = 0;
  private lastStepAll = 0;
  private lastSweep = 0;
  private lastT = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly o: ReplayOptions) {
    const crowd = { trades: (m: string) => this.coins.get(m)?.trades ?? [] } as unknown as CrowdTracker;
    this.book = new VirtualBook(
      crowd,
      (_tag, live) => live,
      (r) => {
        this.results.push({ ...r, sizeSol: this.sizeSol });
        this.openBy.set(r.strategy, Math.max(0, (this.openBy.get(r.strategy) ?? 0) - 1));
      },
      () => getConfig().trading.maxConcurrentPositions,
      (mint, openedAt, _now) => {
        const hc = getConfig().exit.holderClock;
        const wb = this.o.book;
        if (!wb || !hc?.enabled) return null;
        return watchedHolders(this.coins.get(mint)?.trades ?? [], openedAt, (w) => wb.get(w), walletBookConfig(), hc);
      },
    );
    this.sizeSol = getConfig().trading.maxPositionSol;
  }

  /** Tape rows in time order (any chunking). */
  feed(rows: readonly TapeRow[]): void {
    for (const r of rows) {
      if (!(r.px > 0) || r.t < this.o.from || r.t > this.o.to) continue;
      this.rows++;
      this.lastT = Math.max(this.lastT, r.t);
      this.o.book?.onTrade({ mint: r.mint, wallet: r.w, isBuy: r.buy, sol: r.sol, tokens: r.tok, t: r.t, price: r.pp && r.pp > 0 ? r.pp : r.px, creator: this.o.tokens.get(r.mint)?.creator ?? null });
      const coin = this.coin(r.mint, r.t);
      const ct: CrowdTrade = { t: r.t, w: r.w, buy: r.buy, sol: r.sol, tok: r.tok, px: r.px, ...(r.pp && r.pp > 0 ? { pp: r.pp } : {}), ...(r.s ? { s: r.s } : {}) };
      coin.trades.push(ct);
      coin.lastT = r.t;
      coin.volumeSol += r.sol;
      coin.netSol += r.buy ? r.sol : -r.sol;
      coin.net.set(r.w, (coin.net.get(r.w) ?? 0) + (r.buy ? r.tok : -r.tok));
      if (r.amm) {
        if (!coin.amm) {
          coin.amm = true;
          coin.ammSinceT = this.o.tokens.get(r.mint)?.completedAtMs ?? r.t;
        }
      } else if (typeof r.curvePct === 'number') coin.curvePct = r.curvePct;
      if (coin.trades.length % 500 === 0 && r.t - coin.trades[0]!.t > KEEP_MS) {
        const cut = r.t - KEEP_MS;
        let i = 0;
        while (i < coin.trades.length && coin.trades[i]!.t < cut) i++;
        if (i > 0) coin.trades.splice(0, i);
      }
      this.book.onTrade(r.mint, r.t);
      if (r.t - this.lastStepAll >= 1_000) {
        this.book.stepAll(r.t);
        this.lastStepAll = r.t;
      }
      this.maybeEvaluate(coin, r.t);
      if (r.t - this.lastSweep >= 60_000) {
        this.lastSweep = r.t;
        this.o.book?.decay(r.t);
        for (const [m, c] of this.coins) if (r.t - c.lastT > 2 * KEEP_MS && !this.book.has(m)) this.coins.delete(m);
      }
    }
  }

  /** Close what's still open and build the report. */
  finish(id: string): ReplayReport {
    this.book.closeAll('replay ended', this.lastT + 1_000);
    const cfg = getConfig();
    const trades: ReplayTrade[] = this.results.map((r) => ({
      mint: r.mint,
      symbol: r.symbol,
      strategy: r.strategy,
      openedAt: new Date(r.at - r.holdSec * 1000).toISOString(),
      pnlPct: r1(r.pnlPct),
      pnlSol: r3((r.pnlPct / 100) * r.sizeSol),
      peakX: Math.round(r.peakX * 100) / 100,
      holdSec: Math.round(r.holdSec),
      reason: r.reason.split(':')[0] ?? r.reason,
      score: typeof r.tag.score === 'number' ? r1(r.tag.score) : 0,
    }));
    const pcts = trades.map((t) => t.pnlPct).sort((a, b) => a - b);
    const wins = trades.filter((t) => t.pnlSol > 0);
    const grossW = wins.reduce((a, t) => a + t.pnlSol, 0);
    const grossL = trades.filter((t) => t.pnlSol <= 0).reduce((a, t) => a + Math.abs(t.pnlSol), 0);
    const group = <K extends string>(key: (t: ReplayTrade) => K) => {
      const m = new Map<K, ReplayTrade[]>();
      for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
      return [...m.entries()].map(([k, xs]) => ({ key: k, n: xs.length, winRatePct: Math.round((xs.filter((x) => x.pnlSol > 0).length / xs.length) * 100), totalSol: r3(xs.reduce((a, x) => a + x.pnlSol, 0)), avgPct: r1(xs.reduce((a, x) => a + x.pnlPct, 0) / xs.length) }));
    };
    const byPnl = [...trades].sort((a, b) => a.pnlSol - b.pnlSol);
    return {
      id,
      at: new Date().toISOString(),
      from: new Date(this.o.from).toISOString(),
      to: new Date(this.o.to).toISOString(),
      policy: this.o.policy.name,
      overrides: this.o.policy.overrides ?? {},
      rows: this.rows,
      coins: this.coins.size,
      evaluated: this.evaluated,
      signals: this.signals,
      trades: trades.length,
      winRatePct: trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
      totalSol: r3(trades.reduce((a, t) => a + t.pnlSol, 0)),
      avgPct: trades.length ? r1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0,
      medianPct: trades.length ? r1(pcts[Math.floor(pcts.length / 2)]!) : 0,
      profitFactor: grossL > 0 ? r1(grossW / grossL) : trades.length ? null : null,
      sizeSol: cfg.trading.maxPositionSol,
      byStrategy: group((t) => t.strategy).map(({ key, ...r }) => ({ strategy: key, ...r })),
      byExit: group((t) => t.reason).map(({ key, ...r }) => ({ reason: key, ...r })).sort((a, b) => a.totalSol - b.totalSol),
      skips: [...this.skips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
      worst: byPnl.slice(0, 3),
      best: byPnl.slice(-3).reverse(),
      durationMs: Date.now() - this.startedAt,
      note: REPLAY_NOTE,
    };
  }

  private coin(mint: string, t: number): Coin {
    let c = this.coins.get(mint);
    if (!c) {
      c = { mint, trades: [], firstT: t, lastT: t, amm: false, ammSinceT: null, curvePct: null, soonAt: null, nextCurveIdx: 0, nextSoonIdx: 0, nextMigAt: 0, net: new Map(), volumeSol: 0, netSol: 0, lastBuyAt: -Infinity };
      this.coins.set(mint, c);
    }
    return c;
  }

  private maybeEvaluate(coin: Coin, t: number): void {
    const cfg = getConfig();
    const on = cfg.trading.enabledStrategies as Partial<Record<StrategyName, boolean>>;
    const createdAt = this.o.tokens.get(coin.mint)?.createdAtMs ?? coin.firstT;
    if (!coin.amm) {
      if (on.CURVE_SNIPE) {
        const age = (t - createdAt) / 1000;
        while (coin.nextCurveIdx < CURVE_CHECKPOINTS.length && age >= CURVE_CHECKPOINTS[coin.nextCurveIdx]!) {
          const cp = CURVE_CHECKPOINTS[coin.nextCurveIdx++]!;
          if (age - cp <= 30) this.evaluate(coin, 'CURVE_SNIPE', t);
        }
      }
      const soon = cfg.focus.soon;
      if (on.SOON && coin.curvePct !== null) {
        if (coin.soonAt === null && coin.curvePct >= soon.minCurvePct && coin.curvePct <= soon.maxCurvePct) coin.soonAt = t;
        if (coin.soonAt !== null) {
          const since = (t - coin.soonAt) / 1000;
          const cps = soon.checkpointsSec;
          while (coin.nextSoonIdx < cps.length && since >= cps[coin.nextSoonIdx]!) {
            const cp = cps[coin.nextSoonIdx++]!;
            if (since - cp <= 30 && coin.curvePct <= soon.maxCurvePct) this.evaluate(coin, 'SOON', t);
          }
        }
      }
    } else if (on.MIGRATION_MOMENTUM) {
      const m = cfg.focus.migrated;
      const sinceMig = (t - (coin.ammSinceT ?? t)) / 1000;
      if (sinceMig >= m.noEntryFirstSec && t >= coin.nextMigAt) {
        coin.nextMigAt = t + (m.scan?.everySec ?? 15) * 1000;
        this.evaluate(coin, 'MIGRATION_MOMENTUM', t);
      }
    }
  }

  private skip(reason: string, strategy: StrategyName): void {
    const key = `${strategy}: ${reason}`.slice(0, 90);
    this.skips.set(key, (this.skips.get(key) ?? 0) + 1);
  }

  private storedEval(mint: string, t: number): StoredEval | null {
    const xs = this.o.evals?.get(mint);
    if (!xs?.length) return null;
    let best: StoredEval | null = null;
    for (const e of xs) {
      const d = Math.abs(e.tMs - t);
      if (d <= EVAL_MATCH_MS && (!best || d < Math.abs(best.tMs - t))) best = e;
    }
    return best;
  }

  private evaluate(coin: Coin, strategy: StrategyName, t: number): void {
    const trades = coin.trades;
    const last = trades[trades.length - 1];
    if (!last) return;
    const price = last.pp && last.pp > 0 ? last.pp : last.px;
    if (!(price > 0)) return;
    if (t - last.t > 60_000) return;
    this.evaluated++;
    const cfg = getConfig();
    const tok = this.o.tokens.get(coin.mint);
    const createdAt = tok?.createdAtMs ?? coin.firstT;
    const ageSec = Math.max(0, (t - createdAt) / 1000);
    const mcUsd = price * SUPPLY * this.o.solUsd;
    const volumeUsd = coin.volumeSol * this.o.solUsd;
    let holders = 0;
    for (const v of coin.net.values()) if (v > 0) holders++;
    const feesSol = coin.volumeSol * 0.01;
    const lateJoin = coin.firstT - createdAt > 120_000;
    const fails: string[] = [];

    fails.push(...ownerFilterFails({ complete: coin.amm, onAmm: coin.amm, ageSec, marketCapUsd: mcUsd, volumeUsd, liquidityUsd: null, holders, totalFeesSol: feesSol, supplyStandard: true, name: tok?.name ?? '', symbol: tok?.symbol ?? '', lateJoin, narrative: null }, cfg.ownerFilters).fails);

    const feeMin = feeMinimum(cfg.entry.feesByMarketCap, mcUsd);
    const active5m = new Set(trades.filter((x) => t - x.t <= 300_000).map((x) => x.w)).size;
    let flow: OrganicFlow | null = null;
    let threshold: number = cfg.entry.minCombinedScore;
    let minSafety: number = cfg.entry.minSafetyScore;
    if (strategy === 'CURVE_SNIPE') {
      const np = cfg.focus.newPair;
      threshold += np.scoreThresholdDelta ?? 0;
      if (mcUsd < np.minMarketCapUsd || mcUsd > np.maxMarketCapUsd) fails.push(`MC $${Math.round(mcUsd / 100) * 100} outside $${np.minMarketCapUsd}–$${np.maxMarketCapUsd}`);
      if ((coin.curvePct ?? 0) > np.maxCurvePct) fails.push(`curve ${coin.curvePct}% > ${np.maxCurvePct}%`);
      if (coin.netSol < np.minCurveSol) fails.push(`${coin.netSol.toFixed(1)} SOL in the curve < ${np.minCurveSol}`);
      if (!lateJoin && holders < np.minHolders) fails.push(`${holders} holders < ${np.minHolders}`);
      const early = computeEarlyFlow(trades, t, { creator: tok?.creator ?? null, sniperWindowSec: np.sniperWindowSec });
      const creatorNet = tok?.creator ? coin.net.get(tok.creator) ?? 0 : 0;
      const creatorBought = tok?.creator ? trades.filter((x) => x.w === tok.creator && x.buy).reduce((a, x) => a + x.tok, 0) : 0;
      const top10 = [...coin.net.values()].filter((v) => v > 0).sort((a, b) => b - a).slice(0, 10).reduce((a, v) => a + v, 0);
      const npc = newPairCheck(early, { devHoldingPct: (Math.max(0, creatorNet) / SUPPLY) * 100, devSoldFraction: creatorBought > 0 ? Math.max(0, creatorBought - Math.max(0, creatorNet)) / creatorBought : 0, top10HolderPct: (top10 / SUPPLY) * 100, supplyStandard: true, botVolumePct: 0 }, np);
      fails.push(...npc.fails);
    } else if (strategy === 'SOON') {
      const s = cfg.focus.soon;
      threshold += s.scoreThresholdDelta ?? 0;
      minSafety = s.minSafetyScore ?? minSafety;
      if (mcUsd < s.minMarketCapUsd) fails.push(`MC $${Math.round(mcUsd / 100) * 100} < $${s.minMarketCapUsd}`);
      if (!lateJoin && volumeUsd < s.minVolumeUsd) fails.push(`volume $${Math.round(volumeUsd)} < $${s.minVolumeUsd}`);
      if (!lateJoin && feesSol < (feeMin ?? s.minTotalFeesSol)) fails.push(`fees ${feesSol.toFixed(1)} SOL < ${feeMin ?? s.minTotalFeesSol}`);
      if (active5m < s.minActiveWallets5m) fails.push(`${active5m} active wallets (5m) < ${s.minActiveWallets5m}`);
      if (!lateJoin && holders < s.minHolders) fails.push(`${holders} holders < ${s.minHolders}`);
    } else {
      const m = cfg.focus.migrated;
      threshold += m.scoreThresholdDelta ?? 0;
      minSafety = m.minSafetyScore ?? minSafety;
      if (mcUsd < m.minMarketCapUsd) fails.push(`MC $${Math.round(mcUsd / 100) * 100} < $${m.minMarketCapUsd}`);
      if (!lateJoin && feesSol < (feeMin ?? m.minTotalFeesSol)) fails.push(`fees ${feesSol.toFixed(1)} SOL < ${feeMin ?? m.minTotalFeesSol}`);
      if (active5m < m.minActiveWallets5m) fails.push(`${active5m} active wallets (5m) < ${m.minActiveWallets5m}`);
      flow = organicFlow(trades, t);
      const sc = m.scan;
      if (sc?.enabled) {
        if (!flow) fails.push('migrated scan: not enough trades');
        else if (flow.buyers < sc.minOrganicBuyers5m || flow.buySol < sc.minOrganicBuySol5m || flow.buySharePct < sc.minBuySharePct || flow.organicPct < sc.minOrganicPct) fails.push(`migrated scan: ${flow.buyers} real buyers, ${flow.buySol.toFixed(1)} SOL, ${flow.buySharePct}% buys, ${flow.organicPct}% organic`);
        else if ((flow.run3mPct ?? 0) > sc.maxRun3mPct) fails.push(`migrated scan: +${Math.round(flow.run3mPct ?? 0)}% in 3 min (chasing)`);
      }
    }

    const candles = candlesFromTrades(trades, 15_000, t, 60);
    const shape = priceShape(candles, t);
    const stair = staircase(candles, trades, t);
    if (stair.hit) fails.push(stair.why);
    const mg = momentumGateFails(shape, cfg.momentumGate ?? DEFAULT_CONFIG.momentumGate);
    if (mg) fails.push(`momentum gate: ${mg}`);
    const eq = entryQuality(trades.filter((x) => t - x.t <= 120_000), t, cfg.entryQuality ?? DEFAULT_ENTRY_QUALITY);
    if (eq.verdict === 'block') fails.push(`entry quality: ${eq.reason}`);
    const pr = cfg.entry.pressure;
    if (pr?.enabled) {
      const pf = pressureFail(flowPressure(trades, t, pr), pr);
      if (pf) fails.push(pf);
    }
    // v11.6 wallet engine: who is buying (no funder lookups in the replay).
    const wbCfg = cfg.wallets ?? DEFAULT_CONFIG.wallets;
    const cqCfg = wbCfg.entry ?? DEFAULT_CONFIG.wallets.entry;
    const wb = this.o.book;
    const cq = wb && wbCfg.enabled && cqCfg.enabled ? crowdQuality({ trades, now: t }, (w) => wb.get(w), () => null, wbCfg, cqCfg) : null;
    if (cq?.fails.length) fails.push(...cq.fails);
    // v11.10 deployer history (the live records; the tape itself carries no creator history).
    let dp: DeployerView | null = null;
    if (this.o.deployers && (cfg.deployers ?? DEFAULT_CONFIG.deployers).enabled && tok?.creator) {
      dp = this.o.deployers.view(tok.creator, undefined, coin.mint, t);
      if (dp.fails.length) fails.push(...dp.fails);
    }

    const ev = this.storedEval(coin.mint, t);
    let score: number;
    if (ev) {
      score = ev.score;
      if (ev.hardFail) fails.push('safety: hard fail (stored evaluation)');
      else if (ev.safetyScore < minSafety) fails.push(`safety ${Math.round(ev.safetyScore)} < ${minSafety} (stored evaluation)`);
    } else {
      if (!flow) flow = organicFlow(trades, t);
      score = this.tapeScore(coin, trades, t, flow, active5m, holders) + (eq.verdict === 'boost' ? eq.points : 0);
    }
    score += (cq?.points ?? 0) + (dp?.points ?? 0);

    const ctx: EntryContext = { mint: coin.mint, symbol: tok?.symbol ?? '', strategy, now: t, trades, priceSol: price, mcUsd, ageSec, flow, shape, score, threshold, fails };
    const extra = this.o.policy.entry?.(ctx);
    if (extra) fails.push(extra);
    if (fails.length) {
      this.skip(fails[0]!, strategy);
      return;
    }
    if (score < threshold) {
      this.skip(`score under the bar (${threshold})`, strategy);
      return;
    }
    // v11.7 Sniper mode (the same gate as live; learning / probe / risky entries don't exist in the replay).
    const snCfg = cfg.sniper ?? DEFAULT_CONFIG.sniper;
    if (snCfg.enabled) {
      if (!flow) flow = organicFlow(trades, t);
      const sf = sniperEntryFails({ flow, score, threshold, momentumGateWhy: mg, entryQualityVerdict: eq.verdict, edgeGatePass: null, pressureSellersInControl: false, crowd: cq, explore: false, probe: false, risky: false, dipEntry: false, deployerClass: dp?.class ?? null }, snCfg);
      if (sf.length) {
        this.skip(`sniper: ${sf[0]}`, strategy);
        return;
      }
    }
    this.signals++;
    if (this.book.has(coin.mint) || t - coin.lastBuyAt < REBUY_MS) return;
    if (snCfg.enabled && this.book.size >= snCfg.maxOpen) {
      this.skip(`refused: sniper mode max ${snCfg.maxOpen} open`, strategy);
      return;
    }
    const perStrat = (cfg.trading.maxOpenByStrategy as Partial<Record<string, number>> | undefined)?.[strategy];
    if (perStrat !== undefined && (this.openBy.get(strategy) ?? 0) >= perStrat) {
      this.skip(`refused: max ${perStrat} open`, strategy);
      return;
    }
    const ok = this.book.add({ key: coin.mint, mint: coin.mint, symbol: tok?.symbol ?? coin.mint.slice(0, 6), strategy, onAmm: coin.amm, priceSol: price, tag: { strategy, score, t } }, t);
    if (!ok) {
      this.skip('refused: max positions open', strategy);
      return;
    }
    coin.lastBuyAt = t;
    this.openBy.set(strategy, (this.openBy.get(strategy) ?? 0) + 1);
  }

  /** The scorer on what the tape can see; RPC / social features neutral (0.5). */
  private tapeScore(coin: Coin, trades: readonly CrowdTrade[], t: number, flow: OrganicFlow | null, active5m: number, holders: number): number {
    const in5 = trades.filter((x) => t - x.t <= 300_000);
    const in1 = in5.filter((x) => t - x.t <= 60_000);
    const buy5 = in5.filter((x) => x.buy).reduce((a, x) => a + x.sol, 0);
    const vol5 = in5.reduce((a, x) => a + x.sol, 0);
    const vol1 = in1.reduce((a, x) => a + x.sol, 0);
    const prev4avg = (vol5 - vol1) / 4;
    const byWallet = new Map<string, number>();
    for (const x of in5) if (x.buy) byWallet.set(x.w, (byWallet.get(x.w) ?? 0) + x.sol);
    const top3 = [...byWallet.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, v) => a + v, 0);
    const first = trades[0];
    const sniperCut = first ? first.t + 4_000 : -Infinity;
    const sniperBuy = trades.filter((x) => x.buy && x.t <= sniperCut).reduce((a, x) => a + x.sol, 0);
    const allBuy = trades.filter((x) => x.buy).reduce((a, x) => a + x.sol, 0);
    const buyers = new Set(trades.filter((x) => x.buy).map((x) => x.w)).size;
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const f: FeatureVector = {
      safety: 0.5,
      holders: clamp(holders / 200),
      buyPressure: vol5 > 0 ? clamp(buy5 / vol5) : 0.5,
      volume: clamp(vol5 / 50),
      volumeSpike: prev4avg > 0 ? clamp(vol1 / prev4avg / 3) : vol1 > 0 ? 0.7 : 0,
      curveVelocity: clamp(coin.netSol / 40),
      distribution: buy5 > 0 ? clamp(1 - top3 / buy5) : 0.5,
      devHolding: 0.5,
      devBehavior: 0.5,
      snipers: allBuy > 0 ? clamp(1 - sniperBuy / allBuy) : 0.5,
      retention: buyers > 0 ? clamp(holders / buyers) : 0.5,
      creatorLaunches: 0.5,
      creatorSuccess: 0.5,
      funderReuse: 0.5,
      walletAge: 0.5,
      socials: 0.5,
      narrative: 0.5,
      crowd: flow ? clamp(flow.organicPct / 100) : 0.5,
      attention: clamp(active5m / 60),
    };
    return scoreFeatures(f, getWeights().weights).score;
  }
}
