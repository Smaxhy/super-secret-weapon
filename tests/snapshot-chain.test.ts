import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/queues', () => ({ observationQueue: { addBulk: vi.fn(), add: vi.fn(), getJobs: vi.fn() }, QUEUE_NAMES: { observations: 'observations' } }));
vi.mock('../src/lib/redis', () => ({ bullConnection: () => ({}) }));
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));

const NOW = 1_760_000_000_000;

describe('snapshot jobs (v10.32: no long jobs parked for dead coins)', () => {
  it('only the early snapshots are queued up front; 1 h / 6 h / 24 h follow one by one', async () => {
    const { ObservationLogger, nextChained } = await import('../src/learner/observation-logger');
    const { observationQueue } = await import('../src/lib/queues');
    await new ObservationLogger({} as never).scheduleFor('M', NOW);
    const queued = (observationQueue.addBulk as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ name: string }>;
    expect(queued.map((j) => j.name)).toEqual(['CREATION', 'M1', 'M5', 'M15']);
    expect(nextChained('M15')?.interval).toBe('H1');
    expect(nextChained('H6')?.interval).toBe('H24');
    expect(nextChained('H24')).toBeNull();
    expect(nextChained('M5')).toBeNull();
  });
  it('a coin gets the next long snapshot only while it is alive', async () => {
    const { stillAlive } = await import('../src/learner/observation-logger');
    const holders = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`w${i}`, 1n]));
    expect(stillAlive({ complete: true, lastTradeAtMs: null, balances: holders(0) }, NOW)).toBe(true);
    expect(stillAlive({ complete: false, lastTradeAtMs: NOW - 60_000, balances: holders(40) }, NOW)).toBe(true);
    expect(stillAlive({ complete: false, lastTradeAtMs: NOW - 30 * 60_000, balances: holders(40) }, NOW)).toBe(false);
    expect(stillAlive({ complete: false, lastTradeAtMs: NOW - 60_000, balances: holders(4) }, NOW)).toBe(false);
  });
});
