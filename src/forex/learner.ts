/**
 * v17 restricted learner. It reads only the bot's own finished trades in R (the ledger — real fills, never rewritten)
 * and can only do two things to a strategy × chart: size it down, or switch it off. It can never switch anything on or
 * size anything up — that stays with the tested rules (lab verdicts / rolling picker), so it can't learn its way into
 * a lucky streak. Per key: a skeptical average R (shrunk toward 0 as if it already had `priorTrades` break-even
 * trades, results capped at ±3R so one freak trade can't decide) and the chance that its real average is above 0.
 * Off below 20% (after 10+ trades), half size below 40%; it comes back once the chance climbs over 50% or its losing
 * trades age out (120 days). Pure.
 */
import { LEDGER_WHY, type BotLedgerRow } from './practice';

/** fixed before any real result; never tune on dashboard numbers */
export const LEARN = {
  priorTrades: 8,
  capR: 3,
  minSd: 0.8,
  minTradesOff: 10,
  minTradesDown: 6,
  offBelow: 0.2,
  downBelow: 0.4,
  backAbove: 0.5,
  downSize: 0.5,
  days: 120,
};

export type LearnState = 'on' | 'down' | 'off';

export interface LearnKey {
  n: number;
  /** shrunk average R per trade */
  meanR: number;
  /** chance its real average R is above 0 */
  pPos: number;
  state: LearnState;
  /** size multiple it allows (1 or `downSize`; 0 when off) */
  sizeF: number;
  why: string;
}

/** standard normal CDF (Abramowitz–Stegun 7.1.26) */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** The learner's view of every key with ledger trades. `prev` = last run's states (for the way back). Pure. */
export function learnFromLedger(rows: readonly BotLedgerRow[], now: number, prev: Readonly<Record<string, Pick<LearnKey, 'state'>>> = {}): Record<string, LearnKey> {
  const by = new Map<string, number[]>();
  for (const x of rows) {
    if (x.r === null || !Number.isFinite(x.r) || x.why === LEDGER_WHY.manual || now - x.closedAt > LEARN.days * 86_400_000) continue;
    (by.get(x.key) ?? by.set(x.key, []).get(x.key)!).push(Math.max(-LEARN.capR, Math.min(LEARN.capR, x.r)));
  }
  const out: Record<string, LearnKey> = {};
  for (const [key, rs] of by) {
    const n = rs.length;
    const sum = rs.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const sd = Math.max(LEARN.minSd, n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : LEARN.minSd);
    const k = n + LEARN.priorTrades;
    const meanR = sum / k;
    const pPos = normCdf(meanR / (sd / Math.sqrt(k)));
    const was = prev[key]?.state ?? 'on';
    let state: LearnState = 'on';
    if (n >= LEARN.minTradesOff && pPos < LEARN.offBelow) state = 'off';
    else if (n >= LEARN.minTradesDown && pPos < LEARN.downBelow) state = 'down';
    // the way back is slower than the way down: an off / down key stays there until the chance passes 50%
    if (state === 'on' && was !== 'on' && pPos < LEARN.backAbove) state = was === 'off' && n >= LEARN.minTradesOff ? 'off' : 'down';
    const pct = Math.round(pPos * 100);
    const r2 = Math.round(meanR * 100) / 100;
    const why =
      state === 'off'
        ? `off: its last ${n} real trades average ${r2}R (only a ${pct}% chance it really makes money) — no new trades until that passes 50% or the losses age out`
        : state === 'down'
          ? `half size: ${n} real trades average ${r2}R (${pct}% chance it really makes money)`
          : `normal: ${n} real trades average ${r2}R (${pct}% chance it really makes money)`;
    out[key] = { n, meanR: r2, pPos: Math.round(pPos * 1000) / 1000, state, sizeF: state === 'off' ? 0 : state === 'down' ? LEARN.downSize : 1, why };
  }
  return out;
}
