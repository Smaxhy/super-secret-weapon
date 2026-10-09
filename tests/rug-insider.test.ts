import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from '@solana/web3.js';
import { DEFAULT_CONFIG } from '../src/config/default';
import {
  analyzeInsiders,
  buildFundingGraph,
  findRugger,
  findSizeBurst,
  insiderDumpSignal,
  insiderRuleFails,
  InsiderTracker,
  insKey,
  isRugOutcome,
  rememberRugger,
  summarizeInsiders,
  type AntiRugConfig,
  type FunderInfo,
  type FundingRpc,
} from '../src/evaluator/insider-cluster';
import { evaluateSafety, type SafetyInputs } from '../src/evaluator/safety-checker';
import { marketFeatures, withInsider, type MarketRaw } from '../src/evaluator/market-analyzer';
import { TOKEN_2022_PROGRAM_ID } from '../src/lib/pumpfun';
import { randomKey } from './helpers';

/** Minimal in-memory Redis with just the commands insider-cluster uses. */
class MiniRedis {
  kv = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();
  private h(k: string) {
    if (!this.hashes.has(k)) this.hashes.set(k, new Map());
    return this.hashes.get(k)!;
  }
  private s(k: string) {
    if (!this.sets.has(k)) this.sets.set(k, new Set());
    return this.sets.get(k)!;
  }
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.kv.has(k)) return null;
    this.kv.set(k, v);
    return 'OK';
  }
  async expire() { return 1; }
  async sadd(k: string, ...ms: string[]) { ms.forEach((m) => this.s(k).add(m)); return ms.length; }
  async smembers(k: string) { return [...(this.sets.get(k) ?? [])]; }
  async scard(k: string) { return this.sets.get(k)?.size ?? 0; }
  async hincrby(k: string, f: string, by: string | number) {
    const v = BigInt(this.h(k).get(f) ?? '0') + BigInt(by);
    this.h(k).set(f, v.toString());
    return Number(v);
  }
  async hset(k: string, o: Record<string, string>) { Object.entries(o).forEach(([f, v]) => this.h(k).set(f, v)); return 1; }
  async hmget(k: string, ...fs: string[]) { return fs.map((f) => this.hashes.get(k)?.get(f) ?? null); }
  async hgetall(k: string) { return Object.fromEntries(this.hashes.get(k) ?? []); }
  async lpush(k: string, v: string) { const l = this.lists.get(k) ?? []; l.unshift(v); this.lists.set(k, l); return l.length; }
  async lrange(k: string) { return [...(this.lists.get(k) ?? [])]; }
  async ltrim(k: string, a: number, b: number) { this.lists.set(k, (this.lists.get(k) ?? []).slice(a, b + 1)); return 'OK'; }
}
const asRedis = (r: MiniRedis) => r as unknown as Redis;
const cfg: AntiRugConfig = { ...DEFAULT_CONFIG.antiRug };
const SUPPLY = 1_000_000_000_000_000n;
const pctRaw = (p: number) => (SUPPLY * BigInt(Math.round(p * 100))) / 10_000n;

async function seedToken(r: MiniRedis, mint: string, creator: string, balances: Record<string, number>, early: string[] = []) {
  await r.hset(`tok:${mint}:live`, { creator, supply: SUPPLY.toString(), createdAt: '1000000' });
  for (const [w, p] of Object.entries(balances)) await r.hset(`tok:${mint}:bal`, { [w]: pctRaw(p).toString() });
  if (early.length) await r.sadd(`tok:${mint}:early`, ...early);
}

describe('on-stream insider signals', () => {
  it('finds wallets buying near-identical sizes in a burst', () => {
    const buys = [
      { w: 'a', sol: 0.5, sec: 10 },
      { w: 'b', sol: 0.503, sec: 11 },
      { w: 'c', sol: 0.498, sec: 11 },
      { w: 'd', sol: 1.2, sec: 11 },
    ];
    expect(findSizeBurst(buys, cfg).sort()).toEqual(['a', 'b', 'c']);
    expect(findSizeBurst(buys.slice(0, 2), cfg)).toEqual([]);
    expect(findSizeBurst(buys.map((b) => ({ ...b, sol: b.sol / 100 })), cfg)).toEqual([]); // dust ignored
  });

  it('flags bundles, bursts, transfer recipients and dev-slot sellers', async () => {
    const r = new MiniRedis();
    const t = new InsiderTracker(asRedis(r), () => cfg);
    const mint = randomKey();
    const dev = 'DEV';
    await t.onCreate({ mint, creator: dev, timestamp: 100 });
    const trade = (user: string, isBuy: boolean, sol: number, tokens: bigint, ts: number, extra = {}) =>
      t.onTrade({ mint, user, isBuy, lamports: BigInt(Math.round(sol * 1e9)), tokens, timestamp: ts, ...extra });

    await trade(dev, true, 1, 30_000_000_000n, 100);
    await trade('bundler', true, 2, 60_000_000_000n, 101); // within 1s of create
    await trade('late', true, 0.3, 5_000_000_000n, 130);
    await trade('b1', true, 0.7, 10_000_000_000n, 140);
    await trade('b2', true, 0.705, 10_000_000_000n, 141);
    await trade('b3', true, 0.699, 10_000_000_000n, 141);
    await trade('ghost', false, 0.4, 8_000_000_000n, 150); // sold tokens it never bought
    await trade('gifted', true, 0.2, 1_000_000_000n, 151, { balanceAfter: 20_000_000_000n }); // balance ≫ buys
    await trade('sync1', true, 0.3, 4_000_000_000n, 130);
    await trade('sync1', false, 0.3, 4_000_000_000n, 200); // same second as the dev, just before
    await trade(dev, false, 1, 30_000_000_000n, 200);

    expect(await r.smembers(insKey.bundle(mint))).toEqual(['bundler']);
    expect((await r.smembers(insKey.burst(mint))).sort()).toEqual(['b1', 'b2', 'b3']);
    expect((await r.smembers(insKey.xfer(mint))).sort()).toEqual(['ghost', 'gifted']);
    expect(await r.smembers(insKey.devsync(mint))).toEqual(['sync1']);
  });

  it('remembers a creator whose token pumped and was dumped by the dev', async () => {
    const r = new MiniRedis();
    const t = new InsiderTracker(asRedis(r), () => cfg);
    const mint = randomKey();
    await t.onCreate({ mint, creator: 'RUGDEV', timestamp: 100 });
    const tr = (user: string, isBuy: boolean, px: number, ts: number) => t.onTrade({ mint, user, isBuy, lamports: 100_000_000n, tokens: 1_000_000n, timestamp: ts, priceSol: px });
    await tr('x', true, 1e-8, 101);
    await tr('y', true, 6e-8, 300);
    await tr('RUGDEV', false, 3e-8, 400);
    await tr('z', false, 1e-8, 500); // −83% from peak within the hour, dev sold
    const hit = await findRugger(asRedis(r), ['RUGDEV'], 1);
    expect(hit?.rugs).toBe(1);
    expect(hit?.detail).toMatch(/rugged 1 token/);
  });
});

describe('funding graph', () => {
  const fresh = (funder: string | null): FunderInfo => ({ funder, ageHours: 5, veryActive: false });
  it('finds hidden dev wallets and shared-funder clusters, ignoring hubs and old wallets', () => {
    const info = new Map<string, FunderInfo>([
      ['DEV', fresh('MOM')],
      ['h1', fresh('DEV')], // funded by creator
      ['MOM', { funder: 'cex', ageHours: 9000, veryActive: false }], // funded the creator
      ['h2', fresh('MOM')], // sibling of the creator
      ['h3', fresh('h1')], // funded by a hidden wallet
      ['c1', fresh('F')],
      ['c2', fresh('F')],
      ['old', { funder: 'F', ageHours: 5000, veryActive: false }],
      ['hub1', fresh('HUB')],
      ['hub2', fresh('HUB')],
    ]);
    const g = buildFundingGraph('DEV', info, new Set(['HUB']), 72);
    expect(g.creatorFunder).toBe('MOM');
    expect(Object.fromEntries(g.hiddenDev.map((h) => [h.wallet, h.why]))).toEqual({
      h1: 'funded by creator',
      MOM: 'funded the creator',
      h2: 'same funder as creator',
      h3: 'funded by hidden dev wallet',
    });
    expect(g.clusters).toEqual([{ funder: 'F', wallets: ['c1', 'c2'] }]);
  });

  it('feeds hidden wallets into the dev / bundler / single-wallet limits with readable reasons', () => {
    const balances = new Map<string, bigint>([
      ['DEV', pctRaw(5)],
      ['h1', pctRaw(4.5)],
      ['h2', pctRaw(4.5)],
      ['c1', pctRaw(6)],
      ['c2', pctRaw(6)],
      ['e1', pctRaw(3)],
      ['joe', pctRaw(2)],
    ]);
    const funding = {
      creatorFunder: 'MOM',
      hiddenDev: [{ wallet: 'h1', why: 'funded by creator' }, { wallet: 'h2', why: 'funded by creator' }],
      clusters: [{ funder: 'F', wallets: ['c1', 'c2'] }],
      looked: 7,
    };
    const { summary: s, members } = summarizeInsiders({ creator: 'DEV', supply: Number(SUPPLY), balances, early: ['e1'], flags: { bundle: [], burst: [], transfer: [], devSync: [] }, funding });
    expect(s.hiddenDevPct).toBeCloseTo(9);
    expect(s.effectiveDevPct).toBeCloseTo(14);
    expect(s.reasons[0]).toBe('2 hidden dev wallets (funded by creator) hold 9.0% → dev effectively 14.0%');
    expect(s.clusterPct).toBeCloseTo(24); // h1 h2 c1 c2 e1
    expect(s.effectiveMaxHolderPct).toBeCloseTo(12);
    expect(members.sort()).toEqual(['c1', 'c2', 'e1', 'h1', 'h2']);

    const r = insiderRuleFails(s, DEFAULT_CONFIG.entry);
    expect(r.fails).toEqual([
      'dev holds 14.0% > 10% (incl. 2 hidden wallets)',
      'bundlers hold 24.0% > 18% (insider cluster)',
      'one wallet holds 12.0% > 10% (funding cluster)',
    ]);
    // Dev limit via hidden wallets is hard; 24% bundle / 12% cluster are within the risky caps (30 / 15).
    expect(r.hard).toEqual(['dev holds 14.0% > 10% (incl. 2 hidden wallets)']);
  });

  it('looks up funders over RPC once, then serves them from the 24h cache', async () => {
    const r = new MiniRedis();
    const mint = randomKey();
    const dev = randomKey();
    const hidden = randomKey();
    const joe = randomKey();
    await seedToken(r, mint, dev, { [dev]: 4, [hidden]: 8, [joe]: 3 });
    const funders: Record<string, string> = { [hidden]: dev, [joe]: randomKey(), [dev]: randomKey() };
    let calls = 0;
    const rpc: FundingRpc = {
      async getSignaturesForAddress(pk) {
        calls++;
        return [{ signature: `sig-${pk.toBase58()}`, blockTime: Math.floor(Date.now() / 1000) - 3600 } as ConfirmedSignatureInfo];
      },
      async getParsedTransaction(sig) {
        calls++;
        const wallet = sig.slice(4);
        return {
          transaction: { message: { instructions: [{ program: 'system', programId: null, parsed: { type: 'transfer', info: { source: funders[wallet], destination: wallet } } }] } },
          meta: { innerInstructions: [] },
        } as unknown as ParsedTransactionWithMeta;
      },
    };
    const res = await analyzeInsiders(asRedis(r), mint, { funding: 'rpc', rpc, cfg });
    expect(calls).toBe(6); // 3 wallets × 2 calls
    expect(res!.summary.hiddenDevWallets).toEqual([hidden]);
    expect(res!.summary.effectiveDevPct).toBeCloseTo(12);
    expect(insiderRuleFails(res!.summary, DEFAULT_CONFIG.entry).hard).toHaveLength(1);
    // Again: lock + cache → no new RPC calls, same answer.
    const again = await analyzeInsiders(asRedis(r), mint, { funding: 'rpc', rpc, cfg });
    expect(calls).toBe(6);
    expect(again!.summary.hiddenDevWallets).toEqual([hidden]);
    // The cluster set (dev + insiders) is saved for the live dump watch.
    expect((await r.smembers(insKey.cluster(mint))).sort()).toEqual([dev, hidden].sort());
  });
});

describe('serial ruggers', () => {
  it('detects a pump-and-dump from snapshots only when the dev dumped', () => {
    const pts = [
      { marketCapSol: 30, devHoldingPct: 8 },
      { marketCapSol: 90, devHoldingPct: 8 },
      { marketCapSol: 200, devHoldingPct: 3 },
      { marketCapSol: 32, devHoldingPct: 0 },
    ];
    expect(isRugOutcome(pts, 80)).toBe(84);
    expect(isRugOutcome(pts.map((p) => ({ ...p, devHoldingPct: 8 })), 80)).toBeNull(); // organic fade
    expect(isRugOutcome(pts.slice(0, 3), 80)).toBeNull(); // no dump after the peak
  });

  it('remembers ruggers per address and ignores the current mint', async () => {
    const r = asRedis(new MiniRedis());
    await rememberRugger(r, 'FUNDER', { mint: 'old1', dropPct: 91, via: 'exit' }, 30);
    expect(await findRugger(r, [null, 'clean', 'FUNDER'], 1)).toMatchObject({ address: 'FUNDER', rugs: 1 });
    expect(await findRugger(r, ['FUNDER'], 1, 'old1')).toBeNull();
    expect(await findRugger(r, ['FUNDER'], 2)).toBeNull();
  });
});

describe('insiderDumpSignal', () => {
  it('fires when insiders sell a big share of their bag within the window', async () => {
    const r = new MiniRedis();
    const mint = randomKey();
    await seedToken(r, mint, 'DEV', { DEV: 3, e1: 5, e2: 4, joe: 6 }, ['e1', 'e2']);
    const t0 = 1_700_000_000_000;
    expect((await insiderDumpSignal(asRedis(r), mint, { cfg, now: t0 })).dumping).toBe(false);
    await r.hset(`tok:${mint}:bal`, { e1: '0', e2: pctRaw(1).toString() }); // e1 out, e2 4% → 1%
    const sig = await insiderDumpSignal(asRedis(r), mint, { cfg, now: t0 + 20_000 });
    expect(sig.dumping).toBe(true);
    expect(sig.reason).toBe('insiders (3 wallets) sold 67% of their bag in 60s (12.0% → 4.0% of supply)');
    // Outside the window the old bag no longer counts.
    expect((await insiderDumpSignal(asRedis(r), mint, { cfg, now: t0 + 200_000 })).dumping).toBe(false);
  });

  it('ignores tiny insider bags', async () => {
    const r = new MiniRedis();
    const mint = randomKey();
    await seedToken(r, mint, 'DEV', { DEV: 0.2, joe: 9 });
    expect(await insiderDumpSignal(asRedis(r), mint, { cfg })).toMatchObject({ dumping: false, reason: 'insiders hold only 0.2%' });
  });
});

describe('safety + market integration', () => {
  const clean: SafetyInputs = {
    mint: 'm', owner: TOKEN_2022_PROGRAM_ID, mintAuthority: null, freezeAuthority: null, decimals: 6, supply: SUPPLY,
    extensions: [], name: 'Good', symbol: 'GOOD', uri: 'https://x', devInitialBuyPct: 2, creatorBlacklisted: false,
  };
  const summary = (o: Partial<ReturnType<typeof summarizeInsiders>['summary']> = {}) => ({
    ...summarizeInsiders({ creator: 'D', supply: 1, balances: new Map(), early: [], flags: { bundle: [], burst: [], transfer: [], devSync: [] }, funding: null }).summary,
    ...o,
  });

  it('hard-fails a serial rugger and hidden dev wallets over the dev limit', () => {
    expect(evaluateSafety({ ...clean, insider: { summary: summary(), serialRugger: null, maxDevHoldingPct: 10 } }).score).toBe(100);
    const rug = evaluateSafety({ ...clean, insider: { summary: null, serialRugger: 'AbCd…wxyz rugged 2 tokens before', maxDevHoldingPct: 10 } });
    expect(rug.hardFail).toBe(true);
    const hidden = summary({ hiddenDevWallets: ['h1'], hiddenDevPct: 9, devPct: 4, effectiveDevPct: 13, reasons: ['1 hidden dev wallet (funded by creator) hold 9.0% → dev effectively 13.0%'] });
    const r = evaluateSafety({ ...clean, insider: { summary: hidden, serialRugger: null, maxDevHoldingPct: 10 } });
    expect(r.hardFail).toBe(true);
    expect(r.checks.find((c) => c.id === 'hidden_dev')?.detail).toMatch(/hidden dev wallet/);
    const small = evaluateSafety({ ...clean, insider: { summary: { ...hidden, effectiveDevPct: 6, hiddenDevPct: 2 }, serialRugger: null, maxDevHoldingPct: 10 } });
    expect(small.hardFail).toBe(false);
    expect(small.score).toBe(65);
  });

  it('penalises bursts, transfers and dev-slot sells', () => {
    const r = evaluateSafety({ ...clean, insider: { summary: summary({ flags: { bundle: 0, burst: 3, transfer: 1, devSync: 2, fundingClusters: 0 } }), serialRugger: null, maxDevHoldingPct: 10 } });
    expect(r.score).toBe(100 - 10 - 10 - 15);
    expect(r.hardFail).toBe(false);
  });

  it('withInsider adds effective fields and scores on them without touching the ledger numbers', () => {
    const raw = { devHoldingPct: 2, earlyBuyerPct: 5, maxHolderPct: 4, top10HolderPct: 20, holders: 60, buySellRatio: 2, volumeSol: 10, volumeSpikeRatio: 1, curveVelocity: 4, devSoldFraction: 0, retention: 0.8 } as MarketRaw;
    const s = summary({ hiddenDevPct: 8, effectiveDevPct: 10, clusterPct: 20, effectiveBundlePct: 20, effectiveMaxHolderPct: 12, reasons: ['x'] });
    const out = withInsider(raw, s);
    expect(out.raw.devHoldingPct).toBe(2);
    expect(out.raw.earlyBuyerPct).toBe(5);
    expect(out.raw.effectiveDevPct).toBe(10);
    expect(out.features.devHolding).toBe(0);
    expect(out.features.snipers).toBe(0);
    expect(marketFeatures(raw).devHolding).toBeCloseTo(0.8);
    expect(withInsider(raw, null).raw).toBe(raw);
  });
});
