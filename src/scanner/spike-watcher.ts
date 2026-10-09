/**
 * Volume-spike watcher. Every 15s, compare each active token's volume with
 * 15s ago. A sudden burst (≥ minSolPer15s and ≥ multipleOfAverage × its usual
 * pace) gets checked right away instead of waiting for the next scheduled
 * checkpoint — the moments where coins start running.
 */
import { getConfig } from '../config/runtime-config';
import type { Evaluator } from '../evaluator/evaluator';
import { moduleLogger } from '../lib/logger';
import type { LiveState } from './live-state';

const log = moduleLogger('spike-watcher');
const EVERY_MS = 15_000;

export function startSpikeWatcher(liveState: LiveState, evaluator: Evaluator): NodeJS.Timeout {
  const last = new Map<string, number>();
  return setInterval(async () => {
    try {
      const cfg = getConfig().scoring.volumeSpike;
      const active = await liveState.activeVolumes();
      const seen = new Set<string>();
      for (const a of active) {
        seen.add(a.mint);
        const prev = last.get(a.mint);
        last.set(a.mint, a.volumeSol);
        if (prev === undefined || a.ageSec < 30) continue;
        const burst = a.volumeSol - prev;
        const avgPer15s = (a.volumeSol / a.ageSec) * 15;
        if (burst >= cfg.minSolPer15s && burst >= cfg.multipleOfAverage * avgPer15s) {
          log.info({ mint: a.mint, burstSol: +burst.toFixed(2), avgPer15s: +avgPer15s.toFixed(2) }, '⚡ volume spike — checking now');
          await evaluator.checkNow(a.mint, a.complete ? 'MIGRATION_MOMENTUM' : 'CURVE_SNIPE', 'spike');
        }
      }
      for (const m of last.keys()) if (!seen.has(m)) last.delete(m);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'spike scan failed');
    }
  }, EVERY_MS);
}
