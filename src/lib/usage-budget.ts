/**
 * Usage guards (v11.7, owner: "don't drain my Helius / FluxRPC usage"): every RPC request is counted per provider
 * per UTC day (Redis `usage:<provider>:<day>`, kept 3 days, mirrored in memory). OPTIONAL lookups (funding graph,
 * wallet reports, swing-universe holders, X check, Solscan) ask `optionalAllowed()` first and skip once a day's use
 * passes `softPct` of the budget; essential calls (the safety check of a coin about to be bought) always go.
 * Streams (gRPC / WebSocket subscriptions) are not requests and are not counted.
 */
import type Redis from 'ioredis';
import { moduleLogger } from './logger';

const log = moduleLogger('usage');

export type Provider = 'helius' | 'flux' | 'other';

export interface UsageConfig {
  helius: { dailyBudget: number };
  flux: { dailyBudget: number };
  softPct: number;
}

export const DEFAULT_USAGE: UsageConfig = { helius: { dailyBudget: 25_000 }, flux: { dailyBudget: 300_000 }, softPct: 80 };

/** Pure: which provider a URL belongs to. */
export function providerOf(url: string | null | undefined): Provider {
  const u = (url ?? '').toLowerCase();
  if (u.includes('helius')) return 'helius';
  if (u.includes('fluxrpc')) return 'flux';
  return 'other';
}

/** Pure: has today's use reached the soft limit (optional lookups stop)? Budget ≤ 0 = unlimited. */
export function softLimitHit(used: number, budget: number, softPct: number): boolean {
  return budget > 0 && used >= (budget * softPct) / 100;
}

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface UsageSnapshot {
  day: string;
  providers: Record<Provider, { used: number; budget: number; softLimitHit: boolean }>;
}

export class UsageBudget {
  private day = '';
  private used: Record<Provider, number> = { helius: 0, flux: 0, other: 0 };
  private warned = new Set<string>();
  private pending: Record<Provider, number> = { helius: 0, flux: 0, other: 0 };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis | null,
    private readonly cfg: () => UsageConfig,
    private readonly onWarn: ((provider: Provider, used: number, budget: number) => void) | null = null,
  ) {}

  /** Load today's counts (after a restart) and start the 5 s Redis flush. */
  async start(now = Date.now()): Promise<void> {
    this.roll(now);
    if (this.redis) {
      for (const p of ['helius', 'flux', 'other'] as Provider[]) {
        const v = Number((await this.redis.get(`usage:${p}:${this.day}`).catch(() => null)) ?? 0);
        if (Number.isFinite(v) && v > 0) this.used[p] = v;
      }
    }
    this.timer = setInterval(() => void this.flush(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }

  private roll(now: number): void {
    const d = dayKey(now);
    if (d !== this.day) {
      this.day = d;
      this.used = { helius: 0, flux: 0, other: 0 };
      this.warned.clear();
    }
  }

  /** Count `n` requests to a provider (sync, never blocks). */
  note(provider: Provider, n = 1, now = Date.now()): void {
    this.roll(now);
    this.used[provider] += n;
    this.pending[provider] += n;
    const budget = this.budgetOf(provider);
    if (budget > 0 && this.used[provider] >= (budget * this.cfg().softPct) / 100 && !this.warned.has(provider)) {
      this.warned.add(provider);
      log.warn({ provider, used: this.used[provider], budget }, `usage: ${provider} at ${this.cfg().softPct}% of today's budget — optional lookups paused`);
      this.onWarn?.(provider, this.used[provider], budget);
    }
  }

  budgetOf(provider: Provider): number {
    const c = this.cfg();
    return provider === 'helius' ? c.helius.dailyBudget : provider === 'flux' ? c.flux.dailyBudget : 0;
  }

  /** Optional lookups ask this first. */
  optionalAllowed(provider: Provider, now = Date.now()): boolean {
    this.roll(now);
    return !softLimitHit(this.used[provider], this.budgetOf(provider), this.cfg().softPct);
  }

  snapshot(now = Date.now()): UsageSnapshot {
    this.roll(now);
    const providers = {} as UsageSnapshot['providers'];
    for (const p of ['helius', 'flux', 'other'] as Provider[]) {
      const budget = this.budgetOf(p);
      providers[p] = { used: this.used[p], budget, softLimitHit: softLimitHit(this.used[p], budget, this.cfg().softPct) };
    }
    return { day: this.day, providers };
  }

  private async flush(): Promise<void> {
    if (!this.redis) return;
    for (const p of ['helius', 'flux', 'other'] as Provider[]) {
      const n = this.pending[p];
      if (!n) continue;
      this.pending[p] = 0;
      const key = `usage:${p}:${this.day}`;
      await this.redis.incrby(key, n).then(() => this.redis!.expire(key, 3 * 86_400)).catch(() => { this.pending[p] += n; });
    }
  }
}

let current: UsageBudget | null = null;
/** index.ts installs the live budget; the RPC client and optional callers read it from here. */
export function setUsageBudget(b: UsageBudget | null): void {
  current = b;
}
export function noteUsage(provider: Provider, n = 1): void {
  current?.note(provider, n);
}
export function optionalAllowed(provider: Provider): boolean {
  return current ? current.optionalAllowed(provider) : true;
}
export function usageSnapshot(): UsageSnapshot | null {
  return current?.snapshot() ?? null;
}
/** The provider of the main RPC endpoint (set by the RPC client when it connects). */
let rpcProvider: Provider = 'other';
export function setRpcProvider(p: Provider): void {
  rpcProvider = p;
}
export function rpcOptionalAllowed(): boolean {
  return optionalAllowed(rpcProvider);
}
