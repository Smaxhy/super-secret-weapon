import { describe, expect, it } from 'vitest';
import { downsample, pickPoints, PointThrottle } from '../src/executor/position-history';
import { dexPoints, parseOrders, rankTrending, type DexPair } from '../src/scanner/dexscreener';

const pair = (mint: string, vol1h: number, txns: number, pc: number, liq = 10_000, boosts = 0): DexPair => ({
  chainId: 'solana',
  baseToken: { address: mint, symbol: mint.slice(0, 4).toUpperCase() },
  volume: { h1: vol1h },
  txns: { h1: { buys: txns / 2, sells: txns / 2 } },
  priceChange: { h1: pc },
  liquidity: { usd: liq },
  marketCap: 100_000,
  boosts: { active: boosts },
});

describe('DexScreener', () => {
  it('ranks coins by recent activity, one row per token (most liquid pair), Solana only', () => {
    const ranked = rankTrending([
      pair('quietpump', 2_000, 40, 5),
      pair('hotpump', 400_000, 3_000, 120),
      pair('hotpump', 1_000, 10, 0, 50), // smaller pair of the same token is ignored
      { ...pair('ethcoin', 9e6, 9e4, 50), chainId: 'ethereum' },
    ]);
    expect(ranked.map((r) => r.mint)).toEqual(['hotpump', 'quietpump']);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.pump).toBe(true);
    expect(ranked[0]!.volumeH1Usd).toBe(400_000);
  });
  it('reads DEX paid / CTO from the orders endpoint', () => {
    expect(parseOrders([{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 1 }])).toEqual({ paid: true, cto: false, pending: false });
    expect(parseOrders([{ type: 'communityTakeover', status: 'approved' }])).toEqual({ paid: false, cto: true, pending: false });
    expect(parseOrders([{ type: 'tokenProfile', status: 'processing' }]).pending).toBe(true);
    expect(parseOrders([])).toEqual({ paid: false, cto: false, pending: false });
    expect(parseOrders({ weird: true }).paid).toBe(false);
  });
  it('adds points for DEX paid and trending rank', () => {
    const c = { paidPoints: 4, ctoPoints: 2, trendingPoints: 5 };
    const paid = { paid: true, cto: false, pending: false, checkedAt: 0 };
    expect(dexPoints(paid, null, c)).toEqual({ points: 4, notes: ['DEX paid'] });
    const t = rankTrending([pair('hotpump', 400_000, 3_000, 120)])[0]!;
    const r = dexPoints(null, t, c);
    expect(r.points).toBe(5);
    expect(r.notes[0]).toContain('trending #1');
    expect(dexPoints(null, null, c).points).toBe(0);
  });
});

describe('faster charts', () => {
  it('records up to one point a second, and always the spike high', () => {
    const th = new PointThrottle();
    const ev = (priceSol: number, highSol?: number) => ({ type: 'positions' as const, data: { updates: [{ id: 'p', priceSol, highSol, multiple: 1, peakMultiple: 1, unrealizedPnlSol: 0, risk: 0, holders: 1, ownSupplyPct: 0, exitImpactPct: 0 }] } });
    expect(pickPoints(ev(1), th, 1_000)).toHaveLength(1);
    expect(pickPoints(ev(1.01), th, 1_400)).toHaveLength(0); // within 1s
    const spike = pickPoints(ev(1.5, 2.0), th, 1_600); // spike always drawn
    expect(spike.map((x) => x.point.priceSol)).toEqual([2.0, 1.5]);
    expect(pickPoints(ev(1.6), th, 2_100)).toHaveLength(1);
  });
  it('thins long histories but keeps the spikes', () => {
    const pts = Array.from({ length: 6_000 }, (_, i) => ({ t: i * 1000, priceSol: 1 + (i === 3_333 ? 5 : 0) }));
    const out = downsample(pts, 1_500);
    expect(out.length).toBeLessThanOrEqual(1_500);
    expect(Math.max(...out.map((p) => p.priceSol))).toBe(6);
    expect(out[0]!.t).toBe(0);
    expect(out[out.length - 1]!.t).toBe(5_999_000);
  });
});
