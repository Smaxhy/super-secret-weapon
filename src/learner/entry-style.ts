/**
 * Entry style — the bot changes HOW it buys, not only how much (owner: "it sees the error but nothing changes").
 *
 * From the loss autopsy's trades (real + the shadow trades it would have taken), per strategy:
 *   patient     most losers never went up (bad entries) and the strategy loses → only buy after a
 *               pullback: not within `minOffHighPct` of the 10-min high (the dip watcher waits for the dip)
 *   maxRun3m    buying after a big 3-minute run keeps losing while calmer entries do better → no chasing
 *               above that run (wait for a dip instead)
 *   minOffHigh  buying at / near the 10-min high keeps losing → wait until it is that far under the high
 * A strategy that works again (avg − SE > +2%) gets its style cleared. Recomputed every autopsy run.
 */
import type { ClosedTrade } from './loss-autopsy';
import { sniperOn } from '../config/sniper';

export interface EntryStyle {
  strategy: string;
  /** Wait until the price is at least this % under the 10-min high (0 = no rule). */
  minOffHighPct: number;
  /** Don't buy when it ran more than this % in 3 min (null = no rule). */
  maxRun3mPct: number | null;
  why: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const se = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) / Math.sqrt(xs.length);
};
const losing = (xs: number[], min: number) => xs.length >= min && mean(xs) + se(xs) < -3;
const r0 = (x: number) => Math.round(x);

/** Pure: the entry style per strategy (only strategies that need one). */
export function entryStyles(trades: readonly ClosedTrade[], minTrades: number): EntryStyle[] {
  const out: EntryStyle[] = [];
  const half = Math.max(6, Math.round(minTrades / 2));
  for (const s of [...new Set(trades.map((t) => t.strategy))]) {
    const ts = trades.filter((t) => t.strategy === s);
    if (ts.length < minTrades) continue;
    const p = ts.map((t) => t.pnlPct);
    // Working → leave it alone.
    if (mean(p) - se(p) > 2) continue;
    const style: EntryStyle = { strategy: s, minOffHighPct: 0, maxRun3mPct: null, why: [] };
    const losers = ts.filter((t) => t.pnlPct <= 0);
    const neverUp = losers.length ? losers.filter((t) => t.peakMultiple < 1.05).length / losers.length : 0;
    if (mean(p) < 0 && neverUp >= 0.5) {
      style.minOffHighPct = 6;
      style.why.push(`${Math.round(neverUp * 100)}% of its losers never went up → only buys after a pullback (≥6% under the 10-min high)`);
    }
    // Buying at the high: compare entries near the top with the rest.
    const withOff = ts.filter((t) => typeof t.offHigh10m === 'number');
    if (withOff.length >= minTrades) {
      for (const edge of [3, 10]) {
        const near = withOff.filter((t) => t.offHigh10m! < edge).map((t) => t.pnlPct);
        const far = withOff.filter((t) => t.offHigh10m! >= edge).map((t) => t.pnlPct);
        if (losing(near, half) && (far.length < half || mean(far) > mean(near) + 5) && edge > style.minOffHighPct) {
          style.minOffHighPct = edge;
          style.why.push(`entries less than ${edge}% under the 10-min high averaged ${r0(mean(near))}% (${near.length}) vs ${far.length ? `${r0(mean(far))}%` : 'n/a'} → waits until it's ${edge}%+ under the high`);
        }
      }
    }
    // Chasing: entries after a big 3-minute run vs calmer ones.
    const withRun = ts.filter((t) => typeof t.run3m === 'number');
    if (withRun.length >= minTrades) {
      for (const edge of [100, 50, 20]) {
        const chase = withRun.filter((t) => t.run3m! >= edge).map((t) => t.pnlPct);
        const calm = withRun.filter((t) => t.run3m! < edge).map((t) => t.pnlPct);
        if (losing(chase, half) && calm.length >= half && mean(calm) > mean(chase) + 5) {
          style.maxRun3mPct = edge;
          style.why.push(`entries after a ${edge}%+ run in 3 min averaged ${r0(mean(chase))}% (${chase.length}) vs ${r0(mean(calm))}% for calmer ones → no chasing above +${edge}%`);
          break; // the loosest limit that fixes it (fewest good trades lost)
        }
      }
    }
    if (style.why.length) out.push(style);
  }
  return out;
}

/** Pure: does a buy right now break the strategy's entry style? Returns why (→ wait for a dip) or null. */
export function entryStyleBlock(style: EntryStyle | undefined, shape: { offHigh10m: number; run3m: number } | null): string | null {
  if (!style || !shape) return null;
  if (style.maxRun3mPct !== null && shape.run3m > style.maxRun3mPct) return `up ${r0(shape.run3m)}% in 3 min (this strategy loses when it chases more than +${style.maxRun3mPct}%)`;
  if (style.minOffHighPct > 0 && shape.offHigh10m < style.minOffHighPct) return `only ${shape.offHigh10m.toFixed(1)}% under the 10-min high (this strategy now waits for ${style.minOffHighPct}%+)`;
  return null;
}

/** Pure: a simple buy zone under the high when the chart reader didn't give one. */
export function pullbackZone(high: number, minOffHighPct: number): { lo: number; hi: number } {
  const top = Math.max(minOffHighPct, 6);
  return { lo: high * (1 - Math.max(top + 20, 30) / 100), hi: high * (1 - top / 100) };
}

let styles = new Map<string, EntryStyle>();
export const entryStyleFor = (strategy: string): EntryStyle | undefined => (sniperOn() ? undefined : styles.get(strategy)); // v11.7: watch-only in sniper mode
export function setEntryStyles(list: readonly EntryStyle[]): void {
  styles = new Map(list.map((s) => [s.strategy, s]));
}
