import { describe, expect, it } from 'vitest';
import { EXCURSION, excursionOf, excursionReport, underCap, type ExTrade } from '../src/forex/excursion';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0);
// price path for a long at 100, 1 USD per 1.0 move (per = 1)
const bars = (path: Array<[number, number, number]>, start = T0): Bar[] => path.map(([l, h, c], i) => ({ t: start + i * H, o: c, h, l, c }));
const trade = (o: Partial<ExTrade> = {}): ExTrade => ({ id: 'a', pair: 'BTCUSD', strategy: 'rsi_dip', tf: '1h', side: 1, entry: 100, stop: 60, target: 140, units: 1, openedAt: T0, closedAt: T0 + 5 * H, usd: 40, reason: 'target', riskUsd0: 40, capUsd: 20, ...o });

describe('v27.45 excursion study', () => {
  it('measures how deep a winner dipped, when it bottomed and how long it took back to break-even', () => {
    const b = bars([[95, 101, 96], [88, 97, 90], [89, 99, 98], [97, 102, 101], [100, 141, 140]]);
    const x = excursionOf(trade(), b, H, 1, 20)!;
    expect(x.ex.maeUsd).toBe(12);
    expect(x.ex.minsToMae).toBe(60);
    expect(x.ex.minsBackToEven).toBe(180); // bottom candle opened at +1h, back above 100 at the close of the 4th candle (+4h)
    expect(x.ex.win).toBe(true);
    expect(x.ex.capped).toBe(false);
  });

  it('spots a trade the $ cap closed and what its tested trade did afterwards', () => {
    const b = bars([[90, 101, 92], [79, 93, 80], [75, 95, 92], [90, 120, 118], [110, 145, 140]]);
    const t = trade({ closedAt: T0 + 2 * H, usd: -20, reason: 'stop' });
    const x = excursionOf(t, b, H, 1, 20)!;
    expect(x.ex.capped).toBe(true);
    expect(x.ex.after?.kind).toBe('target');
    // a $30 cap would have survived the $25 dip and reached the target; $15 ends at −15
    expect(underCap(x, t, 30)).toBe(40);
    expect(underCap(x, t, 15)).toBe(-15);
    expect(underCap(x, { allIn: true }, 30)).toBe(-20);
  });

  it('suggests caps only with enough trades, blended toward the overall best and clamped', () => {
    const many: ExTrade[] = [];
    const path = bars([[75, 101, 80], [76, 120, 118], [110, 141, 140]]);
    for (let i = 0; i < 25; i++) many.push(trade({ id: `t${i}`, closedAt: T0 + 3 * H, usd: 40 }));
    const rep = excursionReport(many, () => ({ bars: path, barMs: H }), () => 1, 20, T0);
    expect(rep.n).toBe(25);
    expect(rep.winners.over['20']).toBe(25);
    // every winner dipped $25: a cap at or under 25 is touched (stopped), the best is the smallest that holds them
    expect(rep.best?.cap).toBe(30);
    expect(rep.suggest.active).toBe(true);
    expect(rep.suggest.def).toBe(30);
    expect(rep.suggest.byKey['rsi_dip:1h']).toBe(30);
    const few = excursionReport(many.slice(0, 5), () => ({ bars: path, barMs: H }), () => 1, 20, T0);
    expect(few.suggest.active).toBe(false);
    expect(few.suggest.def).toBe(20);
    expect(EXCURSION.maxCap).toBeGreaterThanOrEqual(few.suggest.def);
  });
});
