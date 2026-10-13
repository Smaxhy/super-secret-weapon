/**
 * Paper account reset ("start fresh").
 *
 * Wipes every PAPER trade and position so the balance, profit, win rate,
 * charts and history all start from zero. Learning data (evaluations, outcome
 * labels, beliefs, weights) is kept; Redis `paper:resetAt` records when the
 * reset happened so the learner can ignore older trades.
 *
 * Safe while the bot runs:
 *   1. pause new entries (remember the previous pause state),
 *   2. mark open paper positions CLOSED so the sell manager stops touching
 *      them (its sell transaction only applies to OPEN positions),
 *   3. wait for any fill already in flight (paper fills land in ≤ 1.2s),
 *   4. delete trades + positions in one transaction,
 *   5. optionally set a new starting balance, then restore the pause state.
 */
import { getConfig, updateConfigSection } from '../config/runtime-config';
import { bus } from '../lib/bus';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { TradeCoach } from '../learner/trade-coach';
import { SwingWatcher } from '../executor/swing-watcher';

const log = moduleLogger('paper-reset');

/** Redis key the learner reads (see learner/labels.ts PAPER_RESET_KEY). */
export const PAPER_RESET_AT_KEY = 'paper:resetAt';
export const MIN_START_SOL = 0.1;
export const MAX_START_SOL = 1000;

export interface ResetResult {
  ok: true;
  positions: number;
  trades: number;
  closedOpen: number;
  startingBalanceSol: number;
  resetAt: string;
}

/** Validate an optional new starting balance. undefined = keep current; null = invalid. */
export function parseStartingBalance(v: unknown): number | undefined | null {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < MIN_START_SOL || n > MAX_START_SOL) return null;
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Add fake SOL to the paper balance WITHOUT a reset (trades, stats and everything learned stay).
 * Kept apart from the starting balance so profit stays profit: the top-up is capital, not a win.
 */
export const MAX_ADD_SOL = 1000;
export async function addPaperFunds(sol: number): Promise<{ ok: true; addedSol: number; totalAddedSol: number; startingBalanceSol: number }> {
  const p = getConfig().paper;
  const total = Math.round(((p.addedSol ?? 0) + sol) * 1e4) / 1e4;
  await updateConfigSection('paper', { addedSol: total } as never);
  void recordEvent({ module: 'controls', type: 'paper_topup', message: `Added ${sol} paper SOL (total added since the last reset: ${total} SOL)` });
  bus.publish({ type: 'stats', data: { topUp: true } });
  return { ok: true, addedSol: sol, totalAddedSol: total, startingBalanceSol: p.startingBalanceSol };
}

/**
 * Fresh stats only (owner): balance back to `startSol`, profit counted from now. Nothing is deleted — trades, positions,
 * learning and charts stay; the learners keep reading the full history.
 */
export async function resetPaperStats(startSol: number, now = new Date()): Promise<{ ok: true; startingBalanceSol: number; statsSince: string }> {
  const [buys, sells] = await Promise.all([
    prisma.trade.aggregate({ where: { mode: 'PAPER', side: 'BUY', status: 'SIMULATED' }, _sum: { amountSol: true, feeSol: true } }),
    prisma.trade.aggregate({ where: { mode: 'PAPER', side: 'SELL', status: 'SIMULATED' }, _sum: { amountSol: true, feeSol: true } }),
  ]);
  // Offset so start + offset − buys + sells = startSol right now.
  const net = (buys._sum.amountSol ?? 0) + (buys._sum.feeSol ?? 0) - (sells._sum.amountSol ?? 0) + (sells._sum.feeSol ?? 0);
  const statsSince = now.toISOString();
  await updateConfigSection('paper', { startingBalanceSol: startSol, addedSol: 0, balanceOffsetSol: Math.round(net * 1e6) / 1e6, statsSince } as never);
  void recordEvent({ level: 'WARN', module: 'controls', type: 'paper_stats_reset', message: `Paper stats restarted at ${startSol} SOL (nothing deleted; profit counts from ${statsSince})` });
  bus.publish({ type: 'stats', data: { reset: true, resetAt: statsSince } });
  return { ok: true, startingBalanceSol: startSol, statsSince };
}

let resetting = false;
export const isResetting = () => resetting;

export async function resetPaperAccount(opts: { startingBalanceSol?: number; settleMs?: number } = {}): Promise<ResetResult> {
  if (resetting) throw Object.assign(new Error('A reset is already running'), { statusCode: 409 });
  resetting = true;
  const wasPaused = getConfig().state.paused;
  try {
    if (!wasPaused) await updateConfigSection('state', { paused: true });
    const now = new Date();
    // Freeze open paper positions: the sell manager skips anything not OPEN.
    const frozen = await prisma.position.updateMany({
      where: { mode: 'PAPER', status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: now, exitReason: 'MANUAL', remainingPct: 0 },
    });
    // Let in-flight buys/sells land (or fail their OPEN guard) before deleting.
    const settle = opts.settleMs ?? 1_500;
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));

    const ids = (await prisma.position.findMany({ where: { mode: 'PAPER' }, select: { id: true } })).map((p) => p.id);
    const [t, p] = await prisma.$transaction([prisma.trade.deleteMany({ where: { mode: 'PAPER' } }), prisma.position.deleteMany({ where: { mode: 'PAPER' } })]);

    // A fresh account starts without the old top-ups.
    await updateConfigSection('paper', { ...(opts.startingBalanceSol !== undefined ? { startingBalanceSol: opts.startingBalanceSol } : {}), addedSol: 0, balanceOffsetSol: 0, statsSince: '' } as never);
    const resetAt = now.toISOString();
    try {
      await redis.set(PAPER_RESET_AT_KEY, resetAt);
      // Fresh account: old trade reviews and swing watches shouldn't steer it.
      await TradeCoach.reset(redis);
      await SwingWatcher.reset(redis);
      // Old per-position price charts are no longer reachable.
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500).map((id) => `pos:hist:${id}`);
        if (chunk.length) await redis.del(...chunk);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'redis cleanup after paper reset failed');
    }

    const start = getConfig().paper.startingBalanceSol;
    void recordEvent({
      level: 'WARN',
      module: 'controls',
      type: 'paper_reset',
      message: `Paper account reset to ${start} SOL (${p.count} positions incl. ${frozen.count} open, ${t.count} trades removed)`,
    });
    // Tell open dashboards to refetch everything.
    bus.publish({ type: 'stats', data: { reset: true, resetAt } });
    return { ok: true, positions: p.count, trades: t.count, closedOpen: frozen.count, startingBalanceSol: start, resetAt };
  } finally {
    // Restore the previous state — unless someone hit the kill switch meanwhile.
    if (!wasPaused && !getConfig().state.killSwitch) {
      await updateConfigSection('state', { paused: false }).catch((err: Error) => log.error({ err: err.message }, 'could not un-pause after reset'));
    }
    resetting = false;
  }
}
