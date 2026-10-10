/**
 * New-pair watcher — check a fresh coin the moment its buying heats up.
 *
 * The scheduled checkpoints (45 s, 60 s, 75 s …) can sit right between the moments that matter
 * on a fresh coin. This runs a cheap test on every trade (at most every 2 s per coin): a coin in
 * the new-pair age window with enough different buyers and net SOL coming in over the last
 * minute gets a full evaluation right away (CURVE_SNIPE) — at most once per
 * `focus.newPair.flowCheckCooldownSec` per coin. The evaluator still applies every rule.
 */
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import type { Evaluator } from '../evaluator/evaluator';
import { moduleLogger } from '../lib/logger';
import type { CrowdTrade, CrowdTracker } from './crowd-tracker';
import type { LiveState } from './live-state';

const log = moduleLogger('new-pair-watcher');

/** Pure: cheap pre-filter — enough different buyers and net inflow in the last minute? */
export function hotFlow(trades: readonly CrowdTrade[], now: number, minBuyers: number, minNetSol: number): boolean {
  const buyers = new Set<string>();
  let net = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const x = trades[i]!;
    if (now - x.t > 60_000) break;
    if (x.buy) {
      buyers.add(x.w);
      net += x.sol;
    } else net -= x.sol;
  }
  return buyers.size >= minBuyers && net >= minNetSol;
}

export class NewPairWatcher {
  private readonly lastLook = new Map<string, number>();
  private readonly lastFire = new Map<string, number>();
  fired = 0;

  constructor(
    private readonly crowd: CrowdTracker,
    private readonly liveState: LiveState,
    private readonly evaluator: Evaluator,
  ) {}

  /** A trade happened on `mint` (wired from the token registry). Never throws. */
  onTrade(mint: string, now = Date.now()): void {
    const cfg = getConfig();
    const np = cfg.focus.newPair ?? DEFAULT_CONFIG.focus.newPair;
    if (!cfg.trading.enabledStrategies.CURVE_SNIPE) return;
    if (now - (this.lastLook.get(mint) ?? 0) < 2_000) return;
    this.lastLook.set(mint, now);
    if (this.lastLook.size > 20_000) this.prune(now);
    const meta = this.liveState.meta(mint);
    if (!meta) return;
    const ageSec = now / 1000 - meta.createdSec;
    if (ageSec < np.minAgeSec || ageSec > np.maxAgeSec) return;
    if (now - (this.lastFire.get(mint) ?? 0) < np.flowCheckCooldownSec * 1000) return;
    // Organic filtering happens in the evaluator; this only has to be cheap and not miss.
    if (!hotFlow(this.crowd.trades(mint), now, np.minBuyers60s, np.minNetFlowSol60s)) return;
    this.lastFire.set(mint, now);
    this.fired++;
    void this.evaluator
      .checkNow(mint, 'CURVE_SNIPE', 'new-pair flow', { bucketSec: Math.max(5, np.flowCheckCooldownSec) })
      .catch((err: Error) => log.debug({ mint, err: err.message }, 'new-pair check failed'));
  }

  private prune(now: number): void {
    for (const [m, t] of this.lastLook) if (now - t > 15 * 60_000) this.lastLook.delete(m);
    for (const [m, t] of this.lastFire) if (now - t > 15 * 60_000) this.lastFire.delete(m);
  }
}
