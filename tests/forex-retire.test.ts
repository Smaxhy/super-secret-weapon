import { describe, expect, it } from 'vitest';
import { noPromise, RETIRE, deskWeekend } from '../src/forex/lab';
import { applyExit, strictStopDist } from '../src/forex/exits';
import { buildCtx } from '../src/forex/ta';
import { honestStats } from '../src/forex/honest';
import type { Bar } from '../src/forex/types';

const st = (n: number, avgR: number) => ({ n, avgR, pf: 1, winRate: 0.5, totalR: n * avgR }) as never;
const row = (id: string, tf: string, out: [number, number], o: Record<string, unknown> = {}) => ({ id, name: id, tf, verdict: 'no' as const, outSample: st(...out), ...o }) as never;

describe('v27.37 strict stop + retiring strategies with no promise', () => {
  it('retires only strategies with a fair test and no promise on any chart or market', () => {
    const rows = [
      row('loser', '1h', [50, -0.2]), row('loser', '4h', [30, -0.05]), // 80 unseen, all negative → retired
      row('mixed', '1h', [50, -0.2]), row('mixed', '15m', [40, 0.05]), // one chart positive → kept
      row('young', '1h', [20, -0.5]), // too few unseen trades → kept
      row('maybe', '1h', [70, -0.01], { verdict: 'maybe' }),
      row('cell', '1h', [80, -0.1], { markets: [{ pair: 'NDXUSD', inN: 30, inAvgR: 0.2, n: 40, avgR: 0.3, pf: 2, mcP: 0.99 }] }),
      row('random', '1h', [500, -0.3]),
    ];
    const out = noPromise(rows);
    expect(out.map((x) => x.id)).toEqual(['loser']);
    expect(out[0]!.why).toMatch(/80 unseen trades on 2 charts, best 4h -0.05R/);
    expect(RETIRE.minUnseen).toBe(60);
    expect(deskWeekend('crypto', Date.parse('2026-10-24T12:00:00Z'))).toBe(true);
    expect(deskWeekend('fx', Date.parse('2026-10-21T12:00:00Z'))).toBe(false);
  });

  it('retired strategies still count as trials in the honest statistics', () => {
    const done = Array.from({ length: 40 }, (_, k) => ({ entryT: 100 + k, exitT: 101 + k, r: k % 3 ? 0.5 : -1 })) as never[];
    const a = honestStats([{ key: 'x:1h', isRandom: false, done }], { from: 0, to: 1_000, oosFrom: 50 });
    const b = honestStats([{ key: 'x:1h', isRandom: false, done }], { from: 0, to: 1_000, oosFrom: 50, extraSr: [0.1, -0.2, 0.05] });
    expect(b.report.trials).toBe(a.report.trials + 3);
  });

  it("the friend's very strict stop: 10 Nasdaq points, scaled per market, never inside 3 spreads", () => {
    expect(strictStopDist('NDXUSD', 29_000)).toBe(10);
    expect(strictStopDist('SPXUSD', 7_700)).toBe(2.5);
    expect(strictStopDist('XAUUSD', 4_190)).toBe(1);
    expect(strictStopDist('EURUSD', 1.08)).toBeCloseTo(0.0005, 10);
    expect(strictStopDist('BTCUSD', 100_000)).toBeCloseTo(150, 6);
    const bars: Bar[] = Array.from({ length: 30 }, (_, k) => ({ t: k * 3_600_000, o: 29_000, h: 29_050, l: 28_950, c: 29_000 }));
    const c = buildCtx(bars, 60, 'NDXUSD');
    const sig = applyExit({ side: 1, stop: 28_900, target: 29_200 }, 'strict', c, 29)!;
    expect(sig.stop).toBe(28_990);
    expect(sig.target).toBe(29_200);
    // a stop already tighter than that stays
    expect(applyExit({ side: -1, stop: 29_005, target: 28_900 }, 'strict', c, 29)!.stop).toBe(29_005);
  });
});
