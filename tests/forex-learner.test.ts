import { describe, expect, it } from 'vitest';
import { LEARN, learnFromLedger, normCdf } from '../src/forex/learner';
import type { BotLedgerRow } from '../src/forex/practice';

const NOW = Date.UTC(2026, 9, 19);
const row = (key: string, r: number | null, k: number, why = 1): BotLedgerRow => ({ key, ref: `${key.split(':')[0]}:${key.split(':')[1]}:EURUSD:${k}`, keyT: k, closedAt: NOW - k * 3_600_000, usd: (r ?? 0) * 10, r, why });

describe('v17 restricted learner', () => {
  it('normal CDF', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('switches a steady loser off, halves a doubtful one, leaves a winner alone (and never sizes up)', () => {
    const rows = [
      ...Array.from({ length: 14 }, (_, k) => row('bad:1h', k % 4 === 0 ? 1 : -1, k)),
      ...Array.from({ length: 8 }, (_, k) => row('meh:1h', k % 3 === 0 ? 1 : -1, k)),
      ...Array.from({ length: 14 }, (_, k) => row('good:1h', k % 3 === 0 ? -1 : 1.5, k)),
    ];
    const l = learnFromLedger(rows, NOW);
    expect(l['bad:1h']!.state).toBe('off');
    expect(l['bad:1h']!.sizeF).toBe(0);
    expect(l['meh:1h']!.state).toBe('down');
    expect(l['good:1h']!.state).toBe('on');
    expect(Math.max(...Object.values(l).map((x) => x.sizeF))).toBe(1);
  });

  it('ignores manual closes, unknown R, old trades; one freak loss is capped at 3R', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, k) => row('x:1h', -1, k, 5)), // manual
      ...Array.from({ length: 12 }, (_, k) => row('x:1h', null, k)),
      ...Array.from({ length: 12 }, (_, k) => ({ ...row('x:1h', -1, k), closedAt: NOW - (LEARN.days + 1) * 86_400_000 })),
    ];
    expect(learnFromLedger(rows, NOW)['x:1h']).toBeUndefined();
    const freak = [row('y:1h', -40, 0), ...Array.from({ length: 11 }, (_, k) => row('y:1h', 0.6, k + 1))];
    expect(learnFromLedger(freak, NOW)['y:1h']!.state).toBe('on');
  });

  it('comes back more slowly than it goes down', () => {
    // 14 trades, barely negative: 'on' when fresh (chance 40–50%), but an off / down key needs > 50% to come back
    const rows = Array.from({ length: 14 }, (_, k) => row('z:1h', k % 2 === 0 ? 1 : -1.05, k));
    const fresh = learnFromLedger(rows, NOW)['z:1h']!;
    expect(fresh.pPos).toBeGreaterThan(LEARN.downBelow);
    expect(fresh.pPos).toBeLessThan(LEARN.backAbove);
    expect(fresh.state).toBe('on');
    expect(learnFromLedger(rows, NOW, { 'z:1h': { state: 'off' } })['z:1h']!.state).toBe('off');
    expect(learnFromLedger(rows, NOW, { 'z:1h': { state: 'down' } })['z:1h']!.state).toBe('down');
  });
});
