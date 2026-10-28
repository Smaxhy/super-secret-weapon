import { describe, expect, it } from 'vitest';
import { clashWait, entryIndex, opposedBy, opposedStudy, type ConfTrade, type SideEntry } from '../src/forex/confluence';
import { classify } from '../src/forex/why';

const H = 3_600_000;
const mk = (key: string, side: 1 | -1, entryT: number, r: number): ConfTrade => ({ key, pair: 'BTCUSD', side, entryT, exitT: entryT + 4 * H, r, barMs: 4 * H });

describe('v27.86 clash test', () => {
  it('finds another strategy entering the other way within 2 candles, not the same strategy or random', () => {
    const idx = entryIndex([
      { strategy: 'round_break', pair: 'BTCUSD', side: -1, entryT: 0 },
      { strategy: 'random', pair: 'BTCUSD', side: -1, entryT: 0 },
      { strategy: 'pivot_bounce', pair: 'ETHUSD', side: -1, entryT: 0 },
    ]);
    expect(opposedBy({ strategy: 'round_break', pair: 'BTCUSD', side: 1, entryT: 0 }, idx, 4 * H)).toBeNull();
    const idx2 = entryIndex([{ strategy: 'pivot_bounce', pair: 'BTCUSD', side: -1, entryT: 0 }]);
    expect(opposedBy({ strategy: 'round_break', pair: 'BTCUSD', side: 1, entryT: 8 * H }, idx2, 4 * H)?.strategy).toBe('pivot_bounce');
    expect(opposedBy({ strategy: 'round_break', pair: 'BTCUSD', side: 1, entryT: 8 * H }, idx2, 1 * H)).toBeNull();
    // v27.90: an opponent that enters AFTER the trade isn't counted (no look-ahead)
    expect(opposedBy({ strategy: 'round_break', pair: 'BTCUSD', side: 1, entryT: -H }, idx2, 4 * H)).toBeNull();
  });

  it('switches on only when clashing trades lose more on both parts', () => {
    const oos = 2000 * H;
    const picked: ConfTrade[] = [];
    const opp: SideEntry[] = [];
    for (let i = 0; i < 400; i++) {
      const t = i * 10 * H;
      const clash = i % 2 === 0;
      picked.push(mk('round_break:4h', 1, t, clash ? -0.3 : 0.4));
      if (clash) opp.push({ strategy: 'pivot_bounce', pair: 'BTCUSD', side: -1, entryT: t });
    }
    const on = opposedStudy(picked, entryIndex(opp), oos);
    expect(on.active).toBe(true);
    expect(on.unseen.opposed.n).toBeGreaterThanOrEqual(60);
    // same results either way → stays off
    const flat = opposedStudy(picked.map((p) => ({ ...p, r: 0.1 })), entryIndex(opp), oos);
    expect(flat.active).toBe(false);
  });

  it('live wait text is classified as a clash', () => {
    const w = clashWait({ strategy: 'round_break', pair: 'BTCUSD', side: 1, entryT: 0 }, [{ strategy: 'stoch_trend', pair: 'BTCUSD', side: -1, entryT: 0 }], 4 * H);
    expect(w).toContain('stoch_trend');
    expect(classify(w!)).toBe('clash');
    expect(clashWait({ strategy: 'round_break', pair: 'BTCUSD', side: 1, entryT: 0 }, [{ strategy: 'stoch_trend', pair: 'BTCUSD', side: 1, entryT: 0 }], 4 * H)).toBeNull();
  });
});
