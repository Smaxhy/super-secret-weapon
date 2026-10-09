import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { rankSmartWallets, WalletPnl } from '../src/learner/wallet-pnl';
import { DEFAULT_CONFIG } from '../src/config/default';

/** Minimal hash-only fake Redis for WalletPnl. */
class HRedis {
  h = new Map<string, Map<string, string>>();
  kv = new Map<string, string>();
  private hm(k: string) {
    let m = this.h.get(k);
    if (!m) this.h.set(k, (m = new Map()));
    return m;
  }
  async hget(k: string, f: string) { return this.h.get(k)?.get(f) ?? null; }
  async hexists(k: string, f: string) { return this.h.get(k)?.has(f) ? 1 : 0; }
  async hgetall(k: string) { return Object.fromEntries(this.h.get(k) ?? []); }
  async hset(k: string, f: string, v: string) { this.hm(k).set(f, v); return 1; }
  async hincrbyfloat(k: string, f: string, d: number) { const m = this.hm(k); m.set(f, String(Number(m.get(f) ?? 0) + d)); return m.get(f); }
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string, ..._a: unknown[]) { if (this.kv.has(k) && _a.includes('NX')) return null; this.kv.set(k, v); return 'OK'; }
  async expire() { return 1; }
  private chain() {
    const ops: Array<() => Promise<unknown>> = [];
    const c: Record<string, unknown> = {
      exec: async () => { const out: Array<[null, unknown]> = []; for (const o of ops) out.push([null, await o()]); return out; },
    };
    for (const name of ['hget', 'hexists', 'hset', 'hincrbyfloat', 'expire']) {
      c[name] = (...a: unknown[]) => (ops.push(() => (this as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[name]!(...a)), c);
    }
    return c;
  }
  multi() { return this.chain(); }
  pipeline() { return this.chain(); }
}

describe('smart-money discovery', () => {
  it('ranks profitable, consistent wallets and drops spray bots and losers', () => {
    const c = { ...DEFAULT_CONFIG.discovery, top: 10 };
    const r = rankSmartWallets(
      [
        { wallet: 'pro', pnlSol: 40, sells: 30, wins: 18, investedSol: 100 },
        { wallet: 'lucky', pnlSol: 50, sells: 2, wins: 2, investedSol: 5 }, // too few sells
        { wallet: 'bot', pnlSol: 6, sells: 2000, wins: 1200, investedSol: 900 }, // 0.003 SOL/sell
        { wallet: 'loser', pnlSol: -10, sells: 40, wins: 10, investedSol: 80 },
        { wallet: 'ok', pnlSol: 8, sells: 12, wins: 6, investedSol: 30 },
      ],
      c,
    );
    expect(r.map((x) => x.wallet)).toEqual(['pro', 'ok']);
    expect(r[0]!.winRate).toBeCloseTo(0.6);
  });

  it('realised profit per sell; creators and launch snipers are left out', async () => {
    const redis = new HRedis();
    const p = new WalletPnl(redis as unknown as Redis);
    const t = (wallet: string, isBuy: boolean, sol: number, tokens: number, ageSec = 300, creator: string | null = 'dev') => p.onTrade({ mint: 'm', wallet, isBuy, sol, tokens, ageSec, creator });
    await t('trader', true, 1, 1000);
    await t('trader', false, 1.5, 500); // basis 0.5 → +1.0
    await t('trader', false, 0.2, 500); // basis 0.5 → −0.3
    await t('dev', true, 1, 1000);
    await t('dev', false, 9, 1000); // creator: ignored
    await t('sniper', true, 1, 1000, 3); // bought 3s after launch
    await t('sniper', false, 5, 1000);
    await t('stranger', false, 2, 100); // never saw it buy
    const recs = await p.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ wallet: 'trader', sells: 2, wins: 1 });
    expect(recs[0]!.pnlSol).toBeCloseTo(0.7, 6);
    expect(recs[0]!.investedSol).toBeCloseTo(1, 6);
  });
});
