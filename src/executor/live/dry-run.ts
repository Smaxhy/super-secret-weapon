/**
 * Paper dry run of the live path: every successful paper buy / sell also BUILDS the real transaction for the same
 * trade and SIMULATES it (simulateTransaction — nothing is signed or sent). With no wallet key a throwaway keypair
 * stands in; it holds nothing, so the simulation is expected to stop at the first transfer — `funds` — which still
 * proves every account and instruction layout was accepted. Results → Redis `live:sim` (counters) + `live:sim:last`.
 * Paper fills are returned unchanged and never wait for the simulation.
 */
import { Keypair, type PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import { moduleLogger } from '../../lib/logger';
import { rpcOptionalAllowed } from '../../lib/usage-budget';
import type { BuyRequest, Executor, Fill, SellRequest } from '../types';
import { simCategory, type SimCategory } from './guards';
import { liveConfig, type LiveTxBuilder, type TxKind } from './tx-builder';

const log = moduleLogger('live-dry-run');
const K = { stats: 'live:sim', last: 'live:sim:last' };

export interface SimStats { n: number; ok: number; funds: number; error: number; okPct: number | null; last: Array<{ t: number; side: string; kind: string | null; cat: SimCategory | 'skipped'; err: string | null; cu: number | null }> }

export function simOkPct(s: { n: number; ok: number; funds: number }): number | null {
  return s.n > 0 ? Math.round(((s.ok + s.funds) / s.n) * 1000) / 10 : null;
}

export async function readSimStats(redis: Pick<Redis, 'hgetall' | 'lrange'>): Promise<SimStats> {
  const [h, last] = await Promise.all([redis.hgetall(K.stats).catch(() => ({} as Record<string, string>)), redis.lrange(K.last, 0, 19).catch(() => [] as string[])]);
  const n = Number(h.n ?? 0), ok = Number(h.ok ?? 0), funds = Number(h.funds ?? 0), error = Number(h.error ?? 0);
  return { n, ok, funds, error, okPct: simOkPct({ n, ok, funds }), last: last.map((x) => JSON.parse(x) as SimStats['last'][number]) };
}

export class DryRunExecutor implements Executor {
  readonly mode = 'PAPER' as const;
  private readonly throwaway = Keypair.generate().publicKey;

  constructor(
    private readonly paper: Executor,
    private readonly builder: LiveTxBuilder,
    private readonly redis: Redis,
    private readonly walletKey: PublicKey | null,
  ) {}

  getBalanceSol(): Promise<number> {
    return this.paper.getBalanceSol();
  }

  async buy(req: BuyRequest): Promise<Fill> {
    const fill = await this.paper.buy(req);
    if (fill.ok) void this.simulate('BUY', () => this.builder.prepareBuy(req, this.user()));
    return fill;
  }

  async sell(req: SellRequest): Promise<Fill> {
    const fill = await this.paper.sell(req);
    if (fill.ok) void this.simulate('SELL', () => this.builder.prepareSell(req, this.user(), false));
    return fill;
  }

  private user(): PublicKey {
    return this.walletKey ?? this.throwaway;
  }

  private async simulate(side: 'BUY' | 'SELL', prepare: () => ReturnType<LiveTxBuilder['prepareBuy']>): Promise<void> {
    if (!liveConfig().dryRun.enabled) return;
    if (!rpcOptionalAllowed()) return void this.record(side, null, 'skipped', 'RPC budget soft limit', null);
    let kind: TxKind | null = null;
    try {
      const prep = await prepare();
      kind = prep.kind;
      const tx = await this.builder.toTransaction(prep, this.user(), null, 1_400_000);
      const r = await this.builder.simulate(tx);
      const cat = simCategory(r.err, r.logs);
      if (cat === 'ok') this.builder.noteCu(prep.kind, r.unitsConsumed);
      const errText = r.err ? `${JSON.stringify(r.err)} ${(r.logs ?? []).filter((l) => /error|failed|insufficient/i.test(l)).slice(-2).join(' | ')}`.slice(0, 240) : null;
      await this.record(side, kind, cat, errText, r.unitsConsumed);
    } catch (e) {
      // Building failed (chain read / layout) — that is an error of the live path too.
      await this.record(side, kind, 'error', (e as Error).message.slice(0, 240), null);
    }
  }

  private async record(side: string, kind: string | null, cat: SimCategory | 'skipped', err: string | null, cu: number | null): Promise<void> {
    try {
      const p = this.redis.multi();
      if (cat !== 'skipped') p.hincrby(K.stats, 'n', 1).hincrby(K.stats, cat, 1);
      p.lpush(K.last, JSON.stringify({ t: Date.now(), side, kind, cat, err, cu })).ltrim(K.last, 0, 49);
      await p.exec();
      if (cat === 'error') log.warn({ side, kind, err }, 'live dry run: the real transaction would fail');
    } catch {
      /* stats are best effort */
    }
  }
}
