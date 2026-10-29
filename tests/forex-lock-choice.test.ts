/** v28.6 (owner: "high win rate but the losses outweigh the wins"): every row tests the tight / loose / no profit lock and
 * keeps the one its first 70% scored best on. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, simulate } from '../src/forex/engine';
import { lockCfgOf, LOOSE_LOCK, PROFIT_LOCK } from '../src/forex/profit-lock';
import { chooseVariant } from '../src/forex/filters';
import { buildCtx } from '../src/forex/ta';
import { INSTRUMENTS, type Bar, type Signal } from '../src/forex/types';
import { VENUE_FEES } from '../src/forex/venue-fees';

DEFAULT_SIM.runPastTarget = false;
VENUE_FEES.on = false;
const H = 3_600_000;
const EUR = INSTRUMENTS[0]!;

function market(after: Array<[number, number, number, number]>): Bar[] {
  const t0 = Date.UTC(2025, 0, 6);
  const bars: Bar[] = Array.from({ length: 260 }, (_, i) => ({ t: t0 + i * H, o: 1.1, h: 1.1001, l: 1.0999, c: 1.1 }));
  after.forEach(([o, h, l, c], k) => bars.push({ t: t0 + (260 + k) * H, o, h, l, c }));
  return bars;
}
const sig: Signal = { side: 1, stop: 1.099, target: 1.103 };
const run = (bars: Bar[], lockKind: 'tight' | 'loose' | 'off') => simulate(EUR, '1h', buildCtx(bars, 60, 'EURUSD'), 'x', bars.map((_, i) => (i === 250 ? sig : null)), undefined, { ...DEFAULT_SIM, lockKind })[0]!;

describe('v28.6 the lock each strategy trades with', () => {
  it('settings per kind', () => {
    expect(lockCfgOf('tight')).toBe(PROFIT_LOCK);
    expect(lockCfgOf('loose')).toBe(LOOSE_LOCK);
    expect(lockCfgOf('off')).toBeNull();
    expect(LOOSE_LOCK.atFrac).toBeGreaterThan(PROFIT_LOCK.atFrac);
  });

  it('a winner that dips after a small gain: the tight lock banks crumbs, the loose lock / no lock reach the target', () => {
    // +6 pips, back to the entry, then on to the +30-pip target
    const bars = market([
      [1.1, 1.1006, 1.1, 1.1005],
      [1.1005, 1.1005, 1.09995, 1.1001],
      [1.1001, 1.1015, 1.1, 1.1014],
      [1.1014, 1.1032, 1.1012, 1.1031],
    ]);
    const tight = run(bars, 'tight');
    const loose = run(bars, 'loose');
    const off = run(bars, 'off');
    expect(tight.r).toBeLessThan(0.5);
    expect(tight.r).toBeGreaterThan(-0.2);
    expect(loose.reason).toBe('target');
    expect(loose.r).toBeGreaterThan(2.5);
    expect(off.reason).toBe('target');
    // trades carry the lock they ran with (the bot opens them with it)
    expect(tight.lockKind).toBeUndefined();
    expect(loose.lockKind).toBe('loose');
    expect(off.lockKind).toBe('off');
  });

  it('the tight lock stays unless another one beats it on the first 70% by the usual margin', () => {
    const st = (n: number, avgR: number) => ({ n, avgR, winPct: 50, pf: 1.2, totalR: n * avgR, maxDdR: 3 }) as never;
    expect(chooseVariant([{ key: 'tight', inSample: st(200, 0.05) }, { key: 'loose', inSample: st(190, 0.06) }, { key: 'off', inSample: st(190, 0.02) }], 'tight', 40)).toBe('tight');
    expect(chooseVariant([{ key: 'tight', inSample: st(200, 0.05) }, { key: 'loose', inSample: st(190, 0.2) }, { key: 'off', inSample: st(190, 0.1) }], 'tight', 40)).toBe('loose');
  });
});
