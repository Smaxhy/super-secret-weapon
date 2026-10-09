/**
 * Two sells of the same tokens racing each other (manual "sell now" while the
 * 2s exit tick is also selling, both waiting out the 0.4–1.2s landing delay)
 * must not both be paid out — that double-counts proceeds and fakes profit.
 */
import { describe, expect, it, vi } from 'vitest';

interface Pos {
  id: string; mint: string; mode: 'PAPER'; status: 'OPEN' | 'CLOSED'; strategy: 'CURVE_SNIPE'; remainingPct: number; tokenAmountRaw: bigint;
  sizeSol: number; entryContext: unknown; peakPriceSol: number; entryPriceSol: number; openedAt: Date; realizedPnlSol: number; exitReason?: string | null; closedAt?: Date | null;
}
const { positions, trades, positionApi, q } = vi.hoisted(() => {
const positions = new Map<string, Pos>();
const trades: Array<{ side: string; pnlSol?: number; amount: number }> = [];

function applyData(p: Pos, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) (p as unknown as Record<string, number>)[k]! += (v as { increment: number }).increment;
    else (p as unknown as Record<string, unknown>)[k] = v;
  }
}
const matches = (p: Pos, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (p as unknown as Record<string, unknown>)[k] === v);
const q = { txQueue: Promise.resolve() as Promise<unknown> };

const positionApi = {
  findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
    const p = positions.get(where.id);
    return p ? { ...p, token: { symbol: 'TST' } } : null;
  }),
  findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...positions.get(where.id)! })),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const p = positions.get(where.id)!;
    applyData(p, data);
    return { ...p };
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const p = positions.get(where.id as string);
    if (!p || !matches(p, where)) return { count: 0 };
    applyData(p, data);
    return { count: 1 };
  }),
};
  return { positions, trades, positionApi, q };
});
vi.mock('../src/lib/prisma', () => ({
  prisma: {
    position: positionApi,
    token: { update: vi.fn(async () => ({})) },
    // Serialise transactions like row locks would.
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = q.txQueue.then(() => fn({ position: positionApi, token: { update: vi.fn(async () => ({})) } }));
      q.txQueue = run.catch(() => undefined);
      return run;
    }),
  },
}));
vi.mock('../src/lib/redis', () => ({ redis: {} }));
vi.mock('../src/lib/bot-events', () => ({ recordEvent: vi.fn(async () => undefined) }));
vi.mock('../src/learner/trade-logger', () => ({
  logTrade: vi.fn(async (t: { side: string; pnlSol?: number; fill: { solAmount: number } }) => {
    trades.push({ side: t.side, pnlSol: t.pnlSol, amount: t.fill.solAmount });
    return 'id';
  }),
}));

import type { Redis } from 'ioredis';
import { SellManager } from '../src/executor/sell-manager';
import type { Executor, SellRequest } from '../src/executor/types';
import type { LiveState } from '../src/scanner/live-state';

describe('sell concurrency', () => {
  it('two simultaneous "sell everything" calls sell the position only once', async () => {
    positions.set('P1', {
      id: 'P1', mint: 'M', mode: 'PAPER', status: 'OPEN', strategy: 'CURVE_SNIPE', remainingPct: 100, tokenAmountRaw: 1_000_000_000n,
      sizeSol: 0.5, entryContext: { buyFeeSol: 0.0015 }, peakPriceSol: 1, entryPriceSol: 1, openedAt: new Date(), realizedPnlSol: 0,
    });
    const sells: SellRequest[] = [];
    const executor: Executor = {
      mode: 'PAPER',
      getBalanceSol: async () => 10,
      buy: async () => { throw new Error('unused'); },
      // Each fill takes ~50ms (like the landing delay) and pays 1 SOL.
      sell: async (req) => {
        sells.push(req);
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, status: 'SIMULATED', signature: null, solAmount: 1, tokenAmountRaw: req.tokenAmountRaw, priceSol: 1, feeSol: 0.0015 };
      },
    };
    const sm = new SellManager(executor, {} as LiveState, {} as Redis);
    await Promise.all([sm.closeNow('P1', 'MANUAL'), sm.closeNow('P1', 'MANUAL')]);
    const sellTrades = trades.filter((t) => t.side === 'SELL');
    expect(sellTrades).toHaveLength(1);
    const p = positions.get('P1')!;
    expect(p.status).toBe('CLOSED');
    expect(p.remainingPct).toBe(0);
    expect(p.realizedPnlSol).toBeCloseTo(1 - 0.0015 - 0.5015, 6);
  });
});
