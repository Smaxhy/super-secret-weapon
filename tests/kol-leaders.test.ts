import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { parseWalletList } from '../src/api/routes/wallets';
import { KNOWN_KOLS } from '../src/config/kol-wallets';
import { isValidPubkey } from '../src/lib/pumpfun';
import { kolActivity, kolPoints, recordKolTrade, setKolDirectory } from '../src/scanner/kol-signal';
import { sharedNarratives, topByHourVolume } from '../src/scanner/market-leaders';
import { rugScreen } from '../src/executor/rug-screen';
import { decideExit, type ExitInput } from '../src/executor/sell-manager';
import { DEFAULT_CONFIG } from '../src/config/default';

/** Tiny in-memory sorted-set Redis (just what kol-signal uses). */
class ZRedis {
  z = new Map<string, Map<string, number>>();
  private set(k: string) {
    let m = this.z.get(k);
    if (!m) this.z.set(k, (m = new Map()));
    return m;
  }
  async zadd(k: string, score: string, member: string) { this.set(k).set(member, Number(score)); return 1; }
  async zscore(k: string, m: string) { const v = this.z.get(k)?.get(m); return v === undefined ? null : String(v); }
  async zcard(k: string) { return this.z.get(k)?.size ?? 0; }
  async zcount(k: string, min: string) { return [...(this.z.get(k)?.values() ?? [])].filter((v) => v >= Number(min)).length; }
  async zremrangebyscore(k: string, _min: string, max: string) { for (const [m, v] of this.z.get(k) ?? []) if (v <= Number(max)) this.z.get(k)!.delete(m); return 0; }
  async zrevrangebyscore(k: string, _max: string, min: string, ...rest: Array<string | number>) {
    const rows = [...(this.z.get(k) ?? [])].filter(([, v]) => v >= Number(min)).sort((a, b) => b[1] - a[1]);
    return rest.includes('WITHSCORES') ? rows.flatMap(([m, v]) => [m, String(v)]) : rows.map(([m]) => m);
  }
  async expire() { return 1; }
  async del(k: string) { this.z.delete(k); return 1; }
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      zadd: (k: string, s: string, m: string) => (ops.push(() => this.zadd(k, s, m)), chain),
      expire: () => chain,
      zremrangebyscore: (k: string, a: string, b: string) => (ops.push(() => this.zremrangebyscore(k, a, b)), chain),
      exec: async () => { for (const o of ops) await o(); return []; },
    };
    return chain;
  }
}

const c = DEFAULT_CONFIG.kol;
const NOW = 100_000_000;

describe('KOL signal', () => {
  it('counts KOLs in a coin, drops the ones who sold, flags a dump', async () => {
    const r = new ZRedis() as unknown as Redis;
    setKolDirectory(new Map([['A', { name: 'Cupsey', weight: 1 }], ['B', { name: 'Cented', weight: 1 }], ['C', { name: 'Orangie', weight: 0.5 }]]));
    expect(await recordKolTrade(r, 'mint1', 'A', true, NOW - 10 * 60_000)).toBe(1);
    expect(await recordKolTrade(r, 'mint1', 'B', true, NOW - 5 * 60_000)).toBe(2);
    await recordKolTrade(r, 'mint1', 'C', true, NOW - 60_000);
    await recordKolTrade(r, 'mint1', 'Z', false, NOW); // a non-buyer selling doesn't count
    let a = await kolActivity(r, 'mint1', c, NOW);
    expect(a.buyers.map((b) => b.name)).toEqual(['Orangie', 'Cented', 'Cupsey']);
    expect(a.dumping).toBe(false);
    const pts = kolPoints(a, c);
    expect(pts.points).toBe(7.5); // 3 × (1 + 1 + 0.5)
    expect(pts.notes[0]).toContain('3 KOLs in (Orangie, Cented, Cupsey)');
    await recordKolTrade(r, 'mint1', 'A', false, NOW + 1000);
    await recordKolTrade(r, 'mint1', 'B', false, NOW + 2000);
    a = await kolActivity(r, 'mint1', c, NOW + 3000);
    expect(a.buyers.map((b) => b.name)).toEqual(['Orangie']);
    expect(a.dumping).toBe(true);
    expect(kolPoints(a, c).points).toBe(1.5 - c.dumpPenalty);
  });
  it('caps the bonus', () => {
    const many = { buyers: Array.from({ length: 10 }, (_, i) => ({ wallet: `w${i}`, name: `k${i}`, weight: 1 })), recentSellers: [], everBought: 10, dumping: false };
    expect(kolPoints(many, c).points).toBe(c.maxPoints);
  });
  it('KOLs dumping blocks a buy and banks an open profit', () => {
    const snap = { devHoldingPct: 3, devSoldFraction: 0, earlyBuyerPct: 6, top10HolderPct: 20, liquiditySol: 40, priceSol: 1 };
    expect(rugScreen({ atSignal: snap, now: snap, onAmm: true, flow60s: null, insider: null, maxDevHoldingPct: 10, kolDump: 'Cupsey, Cented sold' })).toContain('KOLs dumping');
    const now = 5_000_000;
    const base: ExitInput = {
      entryPriceSol: 1, peakPriceSol: 1.12, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now, staleMinutes: 30, priceSol: 1.1,
      migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3, top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false,
      risk: 0, riskWhy: '', openedAtMs: now, maxHoldMinutes: 45, resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1, proceedsSol: 0, volatilityPct: null, txFeeSol: 0,
    };
    expect(decideExit({ ...base, kolDump: { hit: true, detail: 'Cupsey sold' } }, DEFAULT_CONFIG.exit).sells[0]?.detail).toContain('KOLs dumping');
    expect(decideExit({ ...base, priceSol: 0.95, kolDump: { hit: true, detail: 'Cupsey sold' } }, DEFAULT_CONFIG.exit).sells).toEqual([]);
  });
});

describe('KOL wallets', () => {
  it('starter list has valid addresses', () => {
    for (const k of KNOWN_KOLS) expect(isValidPubkey(k.address)).toBe(true);
  });
  it('parses pasted lists in any common format', () => {
    const r = parseWalletList(`# my KOLs\nCupsey 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f\nCyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o, @Cented\n96sErVjEN7LNJ6Uvj63bdRWZxNuBngj56fnT9biHLKBf\nnot a wallet`);
    expect(r.valid).toEqual([
      { address: '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f', label: 'Cupsey' },
      { address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', label: 'Cented' },
      { address: '96sErVjEN7LNJ6Uvj63bdRWZxNuBngj56fnT9biHLKBf', label: null },
    ]);
    expect(r.invalid).toEqual(['not a wallet']);
  });
});

describe("what's working now", () => {
  it('finds narratives shared by several top coins', () => {
    const n = sharedNarratives(
      [
        { name: 'Grok Dog', symbol: 'GDOG' },
        { name: 'Baby Grok', symbol: 'BGROK' },
        { name: 'Grok Cat', symbol: 'GCAT', description: 'the cat of grok' },
        { name: 'Moon Cat', symbol: 'MCAT' },
        { name: 'Random', symbol: 'RND' },
      ],
      2,
      10,
    );
    expect(n[0]).toEqual({ word: 'grok', leaders: 3 });
    expect(n.map((x) => x.word)).toContain('cat');
    expect(n.map((x) => x.word)).not.toContain('random');
  });
  it('ranks our coins by volume added in the last hour', () => {
    const now = 10_000_000;
    const s = new Map([
      ['a', [{ t: now - 70 * 60_000, v: 0 }, { t: now - 55 * 60_000, v: 100 }, { t: now - 60_000, v: 160 }]],
      ['b', [{ t: now - 30 * 60_000, v: 10 }, { t: now - 60_000, v: 200 }]],
      ['dead', [{ t: now - 30 * 60_000, v: 0 }, { t: now - 20 * 60_000, v: 999 }]],
    ]);
    expect(topByHourVolume(s, now, 5)).toEqual([{ mint: 'b', volume1h: 190 }, { mint: 'a', volume1h: 60 }]);
  });
});
