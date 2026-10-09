import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = { state: { paused: false, killSwitch: false }, paper: { startingBalanceSol: 10 } };
const calls: string[] = [];
const redisStore = new Map<string, string>();
const deleted: string[] = [];

vi.mock('../src/config/runtime-config', () => ({
  getConfig: () => cfg,
  updateConfigSection: vi.fn(async (k: 'state' | 'paper', patch: object) => {
    calls.push(`${k}:${JSON.stringify(patch)}`);
    Object.assign(cfg[k], patch);
  }),
}));
vi.mock('../src/lib/bot-events', () => ({ recordEvent: vi.fn(async () => undefined) }));
const published: unknown[] = [];
vi.mock('../src/lib/bus', () => ({ bus: { publish: (e: unknown) => published.push(e) } }));
vi.mock('../src/lib/redis', () => ({
  redis: {
    set: vi.fn(async (k: string, v: string) => void redisStore.set(k, v)),
    del: vi.fn(async (...keys: string[]) => void deleted.push(...keys)),
  },
}));
vi.mock('../src/lib/prisma', () => ({
  prisma: {
    position: {
      updateMany: vi.fn(async (a: { where: unknown; data: { status: string } }) => {
        calls.push(`freeze:${a.data.status}:paused=${cfg.state.paused}`);
        return { count: 2 };
      }),
      findMany: vi.fn(async () => [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]),
      deleteMany: vi.fn(async () => ({ count: 3 })),
    },
    trade: { deleteMany: vi.fn(async () => ({ count: 9 })) },
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => {
      calls.push('tx');
      return Promise.all(ops);
    }),
  },
}));

const { parseStartingBalance, resetPaperAccount, PAPER_RESET_AT_KEY } = await import('../src/api/paper-reset');

describe('parseStartingBalance', () => {
  it('accepts 0.1–1000, treats empty as keep', () => {
    expect(parseStartingBalance(undefined)).toBeUndefined();
    expect(parseStartingBalance('')).toBeUndefined();
    expect(parseStartingBalance(10)).toBe(10);
    expect(parseStartingBalance('25.5')).toBe(25.5);
    expect(parseStartingBalance(0.1)).toBe(0.1);
    expect(parseStartingBalance(1000)).toBe(1000);
  });
  it('rejects out of range / junk', () => {
    expect(parseStartingBalance(0.05)).toBeNull();
    expect(parseStartingBalance(1001)).toBeNull();
    expect(parseStartingBalance('abc')).toBeNull();
    expect(parseStartingBalance(Number.NaN)).toBeNull();
  });
});

describe('resetPaperAccount', () => {
  beforeEach(() => {
    calls.length = 0;
    deleted.length = 0;
    published.length = 0;
    redisStore.clear();
    cfg.state.paused = false;
    cfg.state.killSwitch = false;
    cfg.paper.startingBalanceSol = 10;
  });

  it('pauses, freezes open positions, deletes, sets balance, then resumes', async () => {
    const r = await resetPaperAccount({ startingBalanceSol: 25, settleMs: 0 });
    expect(r).toMatchObject({ ok: true, positions: 3, trades: 9, closedOpen: 2, startingBalanceSol: 25 });
    expect(calls).toEqual([
      'state:{"paused":true}',
      'freeze:CLOSED:paused=true',
      'tx',
      'paper:{"startingBalanceSol":25}',
      'state:{"paused":false}',
    ]);
    expect(redisStore.get(PAPER_RESET_AT_KEY)).toBe(r.resetAt);
    expect(deleted).toEqual(['coach:reviews', 'coach:state', 'coach:pending', 'swing:watch', 'pos:hist:p1', 'pos:hist:p2', 'pos:hist:p3']);
    expect(published).toContainEqual({ type: 'stats', data: { reset: true, resetAt: r.resetAt } });
    expect(cfg.state.paused).toBe(false);
  });

  it('keeps a bot that was already paused paused, and keeps balance when not given', async () => {
    cfg.state.paused = true;
    const r = await resetPaperAccount({ settleMs: 0 });
    expect(r.startingBalanceSol).toBe(10);
    expect(calls.filter((c) => c.startsWith('state:'))).toEqual([]);
    expect(cfg.state.paused).toBe(true);
  });

  it('does not un-pause if the kill switch was hit during the reset', async () => {
    const { prisma } = await import('../src/lib/prisma');
    (prisma.trade.deleteMany as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      cfg.state.killSwitch = true;
      return { count: 0 };
    });
    await resetPaperAccount({ settleMs: 0 });
    expect(cfg.state.paused).toBe(true);
  });

  it('refuses a second reset while one runs', async () => {
    const first = resetPaperAccount({ settleMs: 30 });
    await expect(resetPaperAccount({ settleMs: 0 })).rejects.toThrow(/already running/);
    await first;
  });
});
