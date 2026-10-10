/**
 * Running coins feeder (owner: "check the coins already running, not only super new ones"). The scanners
 * (runner / migrated / swing) only see coins the bot follows — ones it saw launch since its last restart.
 * Every `everySec` (and 30 s after a start) this pulls the coins that are running RIGHT NOW from the pump.fun
 * / GeckoTerminal / DexScreener lists and starts following the ones it doesn't know yet:
 *   - still on the bonding curve → followed from their next trade (registry.want)
 *   - migrated → its canonical PumpSwap pool is adopted (same path as the swing universe)
 * Then the normal scanners judge them on their real volume like every other coin.
 */
import { moduleLogger } from '../lib/logger';
import { canonicalPumpPool } from '../lib/pump-pda';
import type { DexScreener } from './dexscreener';
import type { LiveState } from './live-state';
import type { TokenRegistry } from './token-registry';
import type { TrendingHub } from './trending-hub';

const log = moduleLogger('running-coins');

export interface RunningCandidate {
  mint: string;
  symbol: string;
  name: string;
  migrated: boolean | null;
  marketCapUsd: number | null;
}

/** Pure: merge the lists into candidates (pump.fun coins only, one per mint, banned / Mayhem dropped). */
export function runningCandidates(
  trending: ReadonlyArray<{ mint: string; symbol: string; name: string; complete: boolean | null; dex?: string | null; usdMarketCap: number | null; banned: boolean; mayhem: boolean }>,
  dex: ReadonlyArray<{ mint: string; symbol: string; name: string; dexId?: string | null; marketCapUsd: number | null; pump: boolean }>,
): RunningCandidate[] {
  const out = new Map<string, RunningCandidate>();
  for (const t of trending) {
    if (t.banned || t.mayhem || !t.mint.endsWith('pump')) continue;
    const migrated = t.complete ?? (t.dex ? /pumpswap|pump-swap|pump_amm/i.test(t.dex) : null);
    out.set(t.mint, { mint: t.mint, symbol: t.symbol, name: t.name, migrated, marketCapUsd: t.usdMarketCap });
  }
  for (const d of dex) {
    if (!d.pump || out.has(d.mint)) continue;
    const migrated = d.dexId ? d.dexId === 'pumpswap' : null;
    out.set(d.mint, { mint: d.mint, symbol: d.symbol, name: d.name, migrated, marketCapUsd: d.marketCapUsd });
  }
  return [...out.values()];
}

export class RunningCoins {
  private timer: NodeJS.Timeout | null = null;
  stats = { runs: 0, curveWanted: 0, migratedAdopted: 0 };

  constructor(
    private readonly liveState: LiveState,
    private readonly registry: TokenRegistry,
    private readonly trending: TrendingHub | null,
    private readonly dex: DexScreener | null,
    private readonly c: { everySec: number; maxAdoptPerRun: number; minMigratedMcUsd: number } = { everySec: 120, maxAdoptPerRun: 25, minMigratedMcUsd: 25_000 },
  ) {}

  start(): void {
    setTimeout(() => void this.run(), 30_000).unref?.();
    this.timer = setInterval(() => void this.run(), this.c.everySec * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<void> {
    try {
      this.stats.runs++;
      const dexCoins = this.dex?.snapshot().trending ?? [];
      const cands = runningCandidates(this.trending?.snapshot(200) ?? [], dexCoins).filter((c) => !this.liveState.isTracked(c.mint));
      let adopted = 0;
      for (const c of cands) {
        if (c.migrated === false || c.migrated === null) {
          // Unknown stage: watch for a curve trade; if it migrated, its PumpSwap trades never reach the curve path,
          // so a known-big coin also gets its pool adopted below.
          this.registry.want(c.mint);
          this.stats.curveWanted++;
        }
        if (c.migrated === true || (c.migrated === null && (c.marketCapUsd ?? 0) >= 69_000)) {
          if ((c.marketCapUsd ?? this.c.minMigratedMcUsd) < this.c.minMigratedMcUsd || adopted >= this.c.maxAdoptPerRun) continue;
          const pool = canonicalPumpPool(c.mint);
          if (!pool) continue;
          const res = await this.registry
            .adoptMigrated({ mint: c.mint, pool, symbol: c.symbol, name: c.name, createdAtMs: null, migratedAtMs: null })
            .catch(() => 'tracked' as const);
          if (res === 'adopted') {
            adopted++;
            this.stats.migratedAdopted++;
          }
        }
      }
      if (adopted || cands.length) log.info({ candidates: cands.length, migratedAdopted: adopted }, '🏃 following running coins from the trending lists');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'running-coins run failed');
    }
  }
}
