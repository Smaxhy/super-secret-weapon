import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { replayTape, summarize, type BacktestTrade } from '../src/learner/backtester';
import { decodeTape, encodeTape, mergeTrades } from '../src/learner/tape-archiver';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const T0 = 1_700_000_000_000;
/** price path: flat, +80% over 4 min, then back down to −30%. */
function tape(): CrowdTrade[] {
  const out: CrowdTrade[] = [];
  for (let s = 0; s < 1_200; s += 2) {
    const px = s < 120 ? 1e-6 : s < 360 ? 1e-6 * (1 + 0.8 * ((s - 120) / 240)) : 1e-6 * Math.max(0.7, 1.8 - (s - 360) / 300);
    out.push({ t: T0 + s * 1000, w: `w${s % 40}`, buy: s < 360 ? s % 3 !== 0 : s % 3 === 0, sol: 0.2 + (s % 7) * 0.05, tok: 0, px, pp: px });
  }
  return out;
}

describe('tape archive + backtester (owner big update, ported)', () => {
  it('encodes, decodes and merges tapes without duplicates', () => {
    const t = tape().slice(0, 50);
    const { rows, wallets } = encodeTape(t);
    const back = decodeTape(rows, wallets);
    expect(back).toHaveLength(50);
    expect(back[10]!.px).toBeCloseTo(t[10]!.px, 12);
    expect(mergeTrades(back, back.slice(0, 20))).toHaveLength(50);
  });
  it('replays one trade with the live exits and the lab variants on the real path', () => {
    const trade: BacktestTrade = { id: 'p1', mint: 'M', symbol: 'X', strategy: 'MIGRATION_MOMENTUM', openedAtMs: T0 + 130_000, onAmm: true, actualPnlPct: 5 };
    const variants = [{ id: 'L', name: 'Live', exit: {} }, ...(DEFAULT_CONFIG.lab.variants as Array<{ id: string; name: string; exit: object; strategies?: string[] }>).filter((v) => v.id !== 'L')];
    const res = replayTape('M', tape(), [trade], variants);
    // v11.11: strategy-limited variants (E: new pairs + SOON) don't run on a migrated trade
    expect(res.size).toBe(variants.filter((v) => !('strategies' in v) || !v.strategies || v.strategies.includes('MIGRATION_MOMENTUM')).length);
    const live = res.get('p1:L')!;
    expect(live.peakX).toBeGreaterThan(1.4);
    // took profit on the way up → ends in profit even though the coin round-tripped
    expect(live.pnlPct).toBeGreaterThan(0);
    const sum = summarize([trade], res, variants as never);
    expect(sum[0]).toMatchObject({ id: 'L', n: 1 });
  });
});
