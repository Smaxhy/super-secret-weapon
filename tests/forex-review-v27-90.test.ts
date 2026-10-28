// v27.90: fixes from the code review — kept here so they can't come back.
import { describe, expect, it } from 'vitest';
import { equityCurve, simulate, DEFAULT_SIM, WARMUP } from '../src/forex/engine';
import { simulatePortfolio } from '../src/forex/portfolio';
import { addLiq } from '../src/forex/derivs';
import { usdPerPx, pnlUsd } from '../src/forex/practice';
import { buildCtx } from '../src/forex/ta';
import { instrument, type Bar, type Trade } from '../src/forex/types';

const H = 3_600_000;
const tr = (entryT: number, exitT: number, r: number): Trade => ({ strategy: 's', tf: '1h', pair: 'EURUSD', side: 1, entryT, exitT, entry: 1, exit: 1, r, stopPct: 0.2, reason: r < 0 ? 'stop' : 'target', bars: 1, stop: 0.99, stop0: 0.99, target: 1.02 } as Trade);

describe('v27.90 review fixes', () => {
  it('USD per price move: USD/CAD and USD/CHF use their own price (the $ loss cap was 0.4–2.3× off)', () => {
    const mids = { USDCAD: 1.38, USDCHF: 0.8 };
    expect(usdPerPx('USDCAD', mids)).toBeCloseTo(1 / 1.38, 9);
    expect(usdPerPx('USDCHF', mids)).toBeCloseTo(1 / 0.8, 9);
    expect(usdPerPx('EURUSD', mids)).toBe(1);
    expect(usdPerPx('BTCUSD', mids)).toBe(1);
    // a small move agrees with the full P&L maths
    const p = { pair: 'USDCAD', side: 1 as const, units: 10_000, entry: 1.38 };
    expect(pnlUsd(p, 1.3801, mids) / 0.0001).toBeCloseTo(10_000 * usdPerPx('USDCAD', mids), -1);
  });

  it('a trade that ends in its own entry bar still counts (equity curve) and frees its slot (portfolio)', () => {
    const lossSameBar = tr(10 * H, 10 * H, -1);
    expect(equityCurve([lossSameBar], 1, 50).finalX).toBeCloseTo(0.99, 6);
    const later = { ...tr(20 * H, 21 * H, 2), strategy: 'b' };
    const res = simulatePortfolio([{ ...lossSameBar, sizeF: 1 }, { ...later, sizeF: 1 }] as never, { riskPct: 1, maxOpen: 1, perStrategy: 3, ccyCapPct: 99, leverage: 30, marginShare: 1 } as never);
    expect(res.skipped.full).toBe(0);
  });

  it('a pullback fill inside a red candle gets no credit for the high that came before it', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < WARMUP + 3; i++) bars.push({ t: i * H, o: 1.1, h: 1.1003, l: 1.0997, c: 1.1 });
    const n = bars.length;
    // the signal bar closes at 1.1000; the next bar is red: open 1.1000 → high 1.1030 → low 1.0990 → close 1.0995
    bars[n - 2] = { t: (n - 2) * H, o: 1.1, h: 1.103, l: 1.099, c: 1.0995 };
    const c = buildCtx(bars, 60, 'EURUSD');
    const sigs = bars.map((_, i) => (i === n - 3 ? { side: 1 as const, stop: 1.097, target: 1.102 } : null));
    const ts = simulate(instrument('EURUSD')!, '1h', c, 'x', sigs, undefined, { ...DEFAULT_SIM, entry: 'pullback', profitLock: false, runPastTarget: false, venueFees: false, financing: false });
    expect(ts.length).toBeGreaterThan(0);
    // filled on the way down (limit below the close) — the target 1.1020 was only touched BEFORE the fill: no target win
    expect(ts.find((t) => t.reason === 'target')).toBeUndefined();
  });

  it('a late liquidation for an earlier hour adds to that hour (it used to replace it)', () => {
    let rows = addLiq([], { id: 'BTCUSD', t: 10 * H + 5, side: 1, usd: 100 });
    rows = addLiq(rows, { id: 'BTCUSD', t: 11 * H + 5, side: 1, usd: 50 });
    rows = addLiq(rows, { id: 'BTCUSD', t: 10 * H + 9, side: -1, usd: 30 });
    expect(rows).toEqual([[10 * H, 100, 30], [11 * H, 50, 0]]);
  });
});
