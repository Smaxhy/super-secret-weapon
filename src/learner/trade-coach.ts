/**
 * Trade coach — the bot reviews EVERY trade it takes and changes how it trades.
 *
 * When a position fully closes, the coach keeps watching the coin for
 * `WATCH_MIN` minutes (where did the price go after we sold?), then writes a
 * review:
 *
 *   late_entry        never went up after we bought — we bought the top
 *   gave_back_profit  was up 1.3x+ and still closed red
 *   stopped_then_ran  stopped out, then it ran 30%+ above our entry
 *   slow_loser        drifted down, no clear lesson
 *   good_cut          sold at a loss but it kept falling — the stop saved money
 *   sold_too_early    sold in profit, then it went 50%+ higher
 *   good_exit         sold in profit near the top
 *   rug               rug exit
 *
 * From the last reviews per strategy it sets small, bounded adjustments that
 * the evaluator and sell manager read through `coachFor(strategy)`:
 *   thresholdDelta  pickier (+) or easier (−) buy bar   [−5, +12]
 *   sizeFactor      smaller size during a losing streak  [0.35, 1]
 *   stopBiasPct     wider (+) / tighter (−) stop loss   [−5, +5] (stop stays 10–20%)
 *   trailFactor     looser (>1) / tighter (<1) trail    [0.75, 1.3]
 *
 * Reviews and adjustments live in Redis (survive restarts) and show on the
 * dashboard's Learning page.
 */
import type { Redis } from 'ioredis';
import type { StrategyName } from '../config/types';
import { bus, type BusEvent } from '../lib/bus';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { closedPosition, prisma } from '../lib/prisma';
import { readHistory } from '../executor/position-history';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import type { LiveState } from '../scanner/live-state';

const log = moduleLogger('trade-coach');

export type Verdict = 'late_entry' | 'gave_back_profit' | 'stopped_then_ran' | 'slow_loser' | 'good_cut' | 'sold_too_early' | 'good_exit' | 'rug' | 'manual_exit';

export interface TradeReview {
  positionId: string;
  mint: string;
  symbol: string;
  strategy: StrategyName;
  swing: boolean;
  /** A learning trade (near-miss bought small) — reviewed, but it doesn't steer the coach. */
  explore?: boolean;
  pnlSol: number;
  pnlPct: number;
  /** Best / worst price while we held, × entry. */
  peakMultiple: number;
  lowMultiple: number;
  /** Average exit price × entry. */
  exitMultiple: number;
  /** Best / worst price in the WATCH_MIN minutes after we sold, × entry. */
  postHighMultiple: number;
  postLowMultiple: number;
  heldMin: number;
  exitReason: string;
  verdict: Verdict;
  lesson: string;
  at: string;
}

export interface CoachState {
  strategy: StrategyName;
  trades: number;
  winRatePct: number | null;
  lossStreak: number;
  thresholdDelta: number;
  sizeFactor: number;
  stopBiasPct: number;
  trailFactor: number;
  /** Short human summary ("" = nothing to adjust). */
  note: string;
}

export const WATCH_MIN = 30;
const WINDOW = 20;
const NEUTRAL = (strategy: StrategyName): CoachState => ({ strategy, trades: 0, winRatePct: null, lossStreak: 0, thresholdDelta: 0, sizeFactor: 1, stopBiasPct: 0, trailFactor: 1, note: '' });

const K_REVIEWS = 'coach:reviews';
const K_STATE = 'coach:state';
const K_PENDING = 'coach:pending';
const pendKey = (id: string) => `coach:pend:${id}`;

/** Pure: what went right or wrong in one trade. */
export function classifyTrade(r: {
  pnlSol: number;
  peakMultiple: number;
  exitMultiple: number;
  postHighMultiple: number;
  postLowMultiple: number;
  exitReason: string;
  strategy?: string;
}): { verdict: Verdict; lesson: string } {
  const x = (n: number) => `${n.toFixed(2)}x`;
  if (r.exitReason === 'RUG_DETECTED') return { verdict: 'rug', lesson: 'rug/insider exit — similar setups get a stricter bar' };
  // You sold it by hand: that's YOUR exit, never a "good exit" by the bot — it means the bot was too
  // slow to sell (or shouldn't have bought). It sells sooner / buys pickier on this strategy.
  if (r.exitReason === 'MANUAL') {
    return r.pnlSol > 0
      ? { verdict: 'manual_exit', lesson: `you closed it by hand at ${x(r.exitMultiple)} (peak ${x(r.peakMultiple)}) — the bot held too long; it now sells sooner on these` }
      : { verdict: 'manual_exit', lesson: `you closed it by hand at ${x(r.exitMultiple)} — a trade you didn't trust; the bot gets pickier on these` };
  }
  // Swings take profit from +10% (owner) — giving back a +10% swing is already a mistake.
  const gaveBackAt = r.strategy === 'SWING' ? 1.1 : 1.3;
  if (r.pnlSol > 0) {
    if (r.postHighMultiple >= Math.max(1.5, r.exitMultiple * 1.5)) {
      return { verdict: 'sold_too_early', lesson: `sold at ${x(r.exitMultiple)}, it ran to ${x(r.postHighMultiple)} after — let winners run a bit longer` };
    }
    return { verdict: 'good_exit', lesson: `banked ${x(r.exitMultiple)} (peak ${x(r.peakMultiple)})` };
  }
  if (r.peakMultiple >= gaveBackAt) return { verdict: 'gave_back_profit', lesson: `was up ${x(r.peakMultiple)} and still closed red — protect profit sooner` };
  if (r.exitReason === 'STOP_LOSS' && r.postHighMultiple >= 1.3) {
    return { verdict: 'stopped_then_ran', lesson: `stopped out, then it ran to ${x(r.postHighMultiple)} — the stop was too tight for this coin` };
  }
  if (r.peakMultiple < 1.05) return { verdict: 'late_entry', lesson: `never went up after we bought (peak ${x(r.peakMultiple)}) — bought the top` };
  if (r.postLowMultiple <= r.exitMultiple * 0.8) return { verdict: 'good_cut', lesson: `cut at ${x(r.exitMultiple)}, it fell to ${x(r.postLowMultiple)} after — good stop` };
  return { verdict: 'slow_loser', lesson: `drifted down to ${x(r.exitMultiple)}` };
}

/** Pure: per-strategy adjustments from recent reviews (newest first). */
export function computeCoachState(strategy: StrategyName, reviewsNewestFirst: readonly TradeReview[]): CoachState {
  // Learning trades are near-misses by design — their losses mustn't tighten the real trades.
  const list = reviewsNewestFirst.filter((r) => r.strategy === strategy && !r.explore).slice(0, WINDOW);
  const st = NEUTRAL(strategy);
  st.trades = list.length;
  if (list.length < 3) return st;
  const wins = list.filter((r) => r.pnlSol > 0);
  const losses = list.filter((r) => r.pnlSol <= 0);
  const wr = wins.length / list.length;
  st.winRatePct = Math.round(wr * 100);
  let streak = 0;
  for (const r of list) {
    if (r.pnlSol > 0) break;
    streak++;
  }
  st.lossStreak = streak;
  const avgPnlPct = list.reduce((s, r) => s + r.pnlPct, 0) / list.length;
  const share = (arr: readonly TradeReview[], v: Verdict) => (arr.length ? arr.filter((r) => r.verdict === v).length / arr.length : 0);
  const notes: string[] = [];

  let delta = 0;
  if (list.length >= 5 && wr < 0.35) delta += Math.min(8, Math.round((0.35 - wr) * 30));
  if (list.length >= 5 && wr >= 0.55 && avgPnlPct > 0) delta -= 3;
  const late = share(list, 'late_entry');
  if (late >= 0.3) {
    delta += 3;
    notes.push(`${Math.round(late * 100)}% late entries → pickier`);
  }
  if (share(list, 'rug') >= 0.2) delta += 2;
  if (streak >= 3) {
    delta += 4;
    st.sizeFactor = streak >= 5 ? 0.35 : 0.5;
    notes.push(`${streak} losses in a row → size ×${st.sizeFactor}`);
  }
  st.thresholdDelta = Math.max(-5, Math.min(12, delta));

  if (losses.length >= 3) {
    if (share(losses, 'stopped_then_ran') >= 0.35) {
      st.stopBiasPct = 3;
      notes.push('stops hit before runs → wider stop');
    } else if (share(losses, 'good_cut') >= 0.5) {
      st.stopBiasPct = -2;
      notes.push('losers keep falling → tighter stop');
    }
  }
  const exits = list.filter((r) => r.pnlSol > 0 || r.verdict === 'gave_back_profit');
  if (exits.length >= 3) {
    // (swings stay fast — the owner wants profits taken from +10%, so "it ran after" never loosens them)
    if (share(exits, 'sold_too_early') >= 0.4 && strategy !== 'SWING') {
      st.trailFactor = 1.2;
      notes.push('sold too early → looser trail');
    } else if (share(exits, 'gave_back_profit') >= 0.4) {
      st.trailFactor = 0.85;
      notes.push('gave back profits → tighter trail');
    }
  }
  // Trades you closed by hand: the bot was too slow → tighter trail; at a loss → pickier entries.
  const manual = list.filter((r) => r.verdict === 'manual_exit');
  if (manual.length >= 2 || (manual.length >= 1 && list.length <= 4)) {
    st.trailFactor = Math.min(st.trailFactor, 0.8);
    const manualLosses = manual.filter((r) => r.pnlSol <= 0).length;
    if (manualLosses) st.thresholdDelta = Math.max(-5, Math.min(12, st.thresholdDelta + Math.min(4, 2 * manualLosses)));
    notes.push(`you closed ${manual.length} trade${manual.length > 1 ? 's' : ''} by hand → selling sooner${manualLosses ? ', pickier entries' : ''}`);
  }
  if (st.thresholdDelta !== 0) notes.unshift(`buy bar ${st.thresholdDelta > 0 ? '+' : ''}${st.thresholdDelta} (last ${list.length}: ${st.winRatePct}% wins)`);
  st.note = notes.join('; ');
  return st;
}

// ---- in-memory cache read synchronously by the evaluator / sell manager ----
let cache = new Map<string, CoachState>();

export function coachFor(strategy: StrategyName): CoachState {
  return cache.get(strategy) ?? NEUTRAL(strategy);
}

export function setCoachCache(states: readonly CoachState[]): void {
  cache = new Map(states.map((s) => [s.strategy, s]));
}

const STRATEGIES: StrategyName[] = ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SWING'];

export async function readReviews(redis: Redis, limit = 50): Promise<TradeReview[]> {
  const raw = await redis.lrange(K_REVIEWS, 0, limit - 1);
  return raw.flatMap((r) => {
    try {
      return [JSON.parse(r) as TradeReview];
    } catch {
      return [];
    }
  });
}

interface Pending {
  positionId: string;
  mint: string;
  entry: number;
  closedAt: number;
  postHigh: number;
  postLow: number;
  lastSampleAt: number;
}

export class TradeCoach {
  private timer: NodeJS.Timeout | null = null;
  private readonly onBus = (e: BusEvent) => {
    if (e.type !== 'trade') return;
    const d = e.data as { mint?: string; side?: string; closed?: boolean; mode?: string };
    if (d.side === 'SELL' && d.closed && d.mint) void this.onClosed(d.mint).catch((err: Error) => log.warn({ err: err.message }, 'coach: could not start review'));
  };

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly crowd: CrowdTracker | null,
  ) {}

  async start(): Promise<void> {
    await this.recompute().catch(() => undefined);
    bus.on('event', this.onBus);
    this.timer = setInterval(() => void this.tick().catch((err: Error) => log.warn({ err: err.message }, 'coach tick failed')), 20_000);
  }

  stop(): void {
    bus.off('event', this.onBus);
    if (this.timer) clearInterval(this.timer);
  }

  /** A position on `mint` just fully closed: start watching what the price does next. */
  async onClosed(mint: string, now = Date.now()): Promise<void> {
    const p = await closedPosition(mint);
    if (!p) return;
    const pend: Pending = { positionId: p.id, mint, entry: p.entryPriceSol, closedAt: (p.closedAt ?? new Date(now)).getTime(), postHigh: 0, postLow: 0, lastSampleAt: now };
    const added = await this.redis.zadd(K_PENDING, 'NX', String(pend.closedAt + WATCH_MIN * 60_000), p.id);
    if (!added) return;
    await this.redis.set(pendKey(p.id), JSON.stringify(pend), 'EX', (WATCH_MIN + 60) * 60);
  }

  private async tick(now = Date.now()): Promise<void> {
    const ids = await this.redis.zrange(K_PENDING, '0', '-1', 'WITHSCORES');
    for (let i = 0; i < ids.length; i += 2) {
      const id = ids[i]!;
      const due = Number(ids[i + 1]);
      const raw = await this.redis.get(pendKey(id));
      if (!raw) {
        await this.redis.zrem(K_PENDING, id);
        continue;
      }
      const pend = JSON.parse(raw) as Pending;
      // Sample: every trade since the last sample (crowd log) + the current price.
      const pxs = (this.crowd?.trades(pend.mint) ?? []).filter((x) => x.t > pend.lastSampleAt && x.px > 0).map((x) => x.px);
      const nowPx = await this.liveState.priceNow(pend.mint);
      if (nowPx) pxs.push(nowPx);
      for (const px of pxs) {
        pend.postHigh = Math.max(pend.postHigh, px);
        pend.postLow = pend.postLow > 0 ? Math.min(pend.postLow, px) : px;
      }
      pend.lastSampleAt = now;
      if (now < due) {
        await this.redis.set(pendKey(id), JSON.stringify(pend), 'KEEPTTL');
        continue;
      }
      await this.redis.zrem(K_PENDING, id);
      await this.redis.del(pendKey(id));
      await this.finish(pend).catch((err: Error) => log.warn({ id, err: err.message }, 'coach review failed'));
    }
  }

  private async finish(pend: Pending): Promise<void> {
    const p = await prisma.position.findUnique({
      where: { id: pend.positionId },
      include: { token: { select: { symbol: true } }, trades: { where: { side: 'SELL' }, select: { amountSol: true, tokenAmountRaw: true } } },
    });
    if (!p || !(p.entryPriceSol > 0)) return;
    const sold = p.trades.reduce((s, t) => ({ sol: s.sol + t.amountSol, tok: s.tok + Number(t.tokenAmountRaw) / 1e6 }), { sol: 0, tok: 0 });
    const exitPx = sold.tok > 0 ? sold.sol / sold.tok : p.entryPriceSol;
    const hist = await readHistory(p.id).catch(() => []);
    const low = hist.length ? Math.min(...hist.map((h) => h.priceSol).filter((x) => x > 0)) : exitPx;
    const entry = p.entryPriceSol;
    const ctx = (p.entryContext ?? {}) as { buyFeeSol?: number; swing?: boolean; explore?: boolean };
    const cost = p.sizeSol + Number(ctx.buyFeeSol ?? 0);
    const base = {
      pnlSol: p.realizedPnlSol,
      peakMultiple: p.peakPriceSol / entry,
      exitMultiple: exitPx / entry,
      postHighMultiple: pend.postHigh > 0 ? pend.postHigh / entry : exitPx / entry,
      postLowMultiple: pend.postLow > 0 ? pend.postLow / entry : exitPx / entry,
      exitReason: p.exitReason ?? 'UNKNOWN',
    };
    const { verdict, lesson } = classifyTrade({ ...base, strategy: p.strategy });
    const review: TradeReview = {
      positionId: p.id,
      mint: p.mint,
      symbol: p.token.symbol,
      strategy: p.strategy as StrategyName,
      swing: ctx.swing === true,
      explore: ctx.explore === true,
      ...base,
      pnlPct: cost > 0 ? (p.realizedPnlSol / cost) * 100 : 0,
      lowMultiple: Number.isFinite(low) && low > 0 ? Math.min(low, exitPx) / entry : exitPx / entry,
      heldMin: p.closedAt ? (p.closedAt.getTime() - p.openedAt.getTime()) / 60_000 : 0,
      verdict,
      lesson,
      at: new Date().toISOString(),
    };
    await this.redis.multi().lpush(K_REVIEWS, JSON.stringify(review)).ltrim(K_REVIEWS, 0, 299).exec();
    // Show the lesson with the trade itself.
    await prisma.position.update({ where: { id: p.id }, data: { entryContext: { ...(p.entryContext as object), review: { verdict, lesson } } } }).catch(() => undefined);
    const states = await this.recompute();
    const st = states.find((s) => s.strategy === review.strategy);
    log.info({ symbol: review.symbol, verdict, pnlSol: +review.pnlSol.toFixed(4), adjust: st?.note }, `🧑‍🏫 ${review.symbol}: ${lesson}`);
    void recordEvent({ module: 'coach', type: 'trade_review', mint: p.mint, message: `${review.symbol}: ${lesson}${st?.note ? ` · ${st.note}` : ''}`, data: { verdict, strategy: review.strategy } });
    bus.publish({ type: 'stats', data: { coach: { review, state: st ?? null } } });
  }

  /** Rebuild every strategy's adjustments from the stored reviews. */
  async recompute(): Promise<CoachState[]> {
    const reviews = await readReviews(this.redis, 200);
    const states = STRATEGIES.map((s) => computeCoachState(s, reviews));
    setCoachCache(states);
    await this.redis.set(K_STATE, JSON.stringify(states));
    return states;
  }

  /** Wipe reviews (paper reset): old mistakes shouldn't steer the fresh account. */
  static async reset(redis: Redis): Promise<void> {
    await redis.del(K_REVIEWS, K_STATE, K_PENDING);
    setCoachCache([]);
  }
}

export async function coachSnapshot(redis: Redis): Promise<{ states: CoachState[]; reviews: TradeReview[] }> {
  const reviews = await readReviews(redis, 30);
  const states = STRATEGIES.map((s) => coachFor(s));
  return { states, reviews };
}
