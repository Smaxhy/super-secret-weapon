import { describe, expect, it } from 'vitest';
import { avgApy, carryTest, simulateCarry, type CarryCoin } from '../src/forex/carry';

const H = 3_600_000;
const T0 = Date.UTC(2023, 0, 1);

function coin(id: string, days: number, rate: (i: number) => number, price: (t: number) => number = () => 100): CarryCoin {
  const fund: Array<[number, number]> = [];
  for (let i = 0; i < days * 3; i++) fund.push([T0 + i * 8 * H, rate(i)]);
  const bars = [];
  for (let t = T0; t <= T0 + days * 24 * H; t += H) bars.push({ t, h: price(t) * 1.001, c: price(t) });
  return { id, fund, bars };
}

describe('funding carry', () => {
  it('annualises the 7-day average funding', () => {
    const c = coin('BTCUSD', 20, () => 0.01);
    const a = avgApy(c.fund);
    expect(Number.isNaN(a[0]!)).toBe(true);
    // 0.01% every 8 h ≈ 10.95% a year
    expect(a[a.length - 1]!).toBeCloseTo(10.95, 1);
  });

  it('steady positive funding passes on unseen data, net of costs', () => {
    const coins = ['BTCUSD', 'ETHUSD', 'SOLUSD'].map((id) => coin(id, 900, () => 0.02));
    const r = carryTest(coins, T0 + 900 * 24 * H);
    expect(r.rule).not.toBeNull();
    expect(r.unseen!.totalPct).toBeGreaterThan(0);
    expect(r.unseen!.costPct).toBeGreaterThan(0);
    expect(r.verdict).toBe('edge');
    expect(r.now.every((x) => x.inNow)).toBe(true);
  });

  it('funding that turns negative after the line is graded as a loss or a pass-by', () => {
    const coins = ['BTCUSD', 'ETHUSD'].map((id) => coin(id, 900, (i) => (i < 900 * 3 * 0.7 ? 0.02 : -0.02)));
    const r = carryTest(coins, T0 + 900 * 24 * H);
    expect(r.verdict === 'no' || r.verdict === 'maybe').toBe(true);
    expect(r.unseen!.totalPct).toBeLessThanOrEqual(0.5);
  });

  it('a price that doubles liquidates the perp leg and costs a fee', () => {
    const c = coin('SOLUSD', 60, () => 0.02, (t) => (t > T0 + 30 * 24 * H ? 220 : 100));
    const tr = simulateCarry(c, { entryApy: 5, exitApy: 0 }, T0, T0 + 60 * 24 * H);
    expect(tr.some((x) => x.liquidated)).toBe(true);
    const liq = tr.find((x) => x.liquidated)!;
    expect(liq.costPct).toBeGreaterThan(tr.find((x) => !x.liquidated)?.costPct ?? 0);
  });
});

import { STRATEGIES } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import type { Bar } from '../src/forex/types';

describe('v28.16 strategies from go-trader’s list', () => {
  const NEW = ['heikin_ema', 'vortex_cross', 'aroon_trend', 'kama_trend', 'trix_zero', 'awesome_zero', 'elder_ray', 'fisher_turn', 'connors_rsi', 'mfi_turn', 'camarilla', 'dual_thrust'];
  function bars(n: number): Bar[] {
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
    const out: Bar[] = [];
    let px = 1.1;
    for (let i = 0; i < n; i++) {
      const o = px;
      px = Math.max(0.5, px * (1 + rnd() * 0.006 + Math.sin(i / 90) * 0.0006));
      const h = Math.max(o, px) * (1 + Math.abs(rnd()) * 0.002);
      const l = Math.min(o, px) * (1 - Math.abs(rnd()) * 0.002);
      out.push({ t: T0 + i * H, o, h, l, c: px, v: 1000 + Math.abs(rnd()) * 500 });
    }
    return out;
  }
  it('every new rule is registered and fires on a long synthetic chart, both ways', () => {
    const c = buildCtx(bars(4000), 60, 'EURUSD');
    for (const id of NEW) {
      const s = STRATEGIES.find((x) => x.id === id);
      expect(s, id).toBeDefined();
      let longs = 0;
      let shorts = 0;
      for (let i = 250; i < 4000; i++) {
        const sig = s!.signal(c, i);
        if (!sig) continue;
        expect((c.close[i]! - sig.stop) * sig.side, id).toBeGreaterThan(0);
        if (sig.side > 0) longs++;
        else shorts++;
      }
      expect(longs, `${id} longs`).toBeGreaterThan(0);
      expect(shorts, `${id} shorts`).toBeGreaterThan(0);
    }
  });
});
