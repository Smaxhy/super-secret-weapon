/**
 * Outcome labels — the "answer key" every part of the learner trains on.
 *
 * A token counts as a WIN only if you could realistically have banked it:
 * it reached `winMultiple` (1.8×) BEFORE it ever dropped to
 * `drawdownLossMultiple` (0.7×) of the evaluation price. A coin that dumps
 * to 0.6× first and pumps later would have stopped us out → LOSS.
 *
 * The outcome window is sampled at a series of "peeks" during the hour, so we
 * know roughly WHEN the win / loss thresholds were first crossed. If both were
 * crossed between the same two peeks we can't tell the order → counted as a
 * loss (conservative).
 *
 * For tokens we actually bought, the realised trade result (P&L after every
 * fee) beats the price-path guess.
 *
 * Bad data is excluded from ALL learning: price data flagged by a
 * 'suspicious_fill' event, implausible pumps (> 25× within the hour), and
 * anything from before the last paper reset.
 */
import type { Redis } from 'ioredis';

/** Minutes after the evaluation at which the outcome window is sampled. The last one labels. */
export const PEEK_MINUTES = [1, 3, 6, 10, 15, 22, 30, 40, 50, 60] as const;

export type ExcludeReason = 'suspicious_fill' | 'implausible_multiple' | 'before_reset';

export interface LabelOptions {
  winMultiple: number;
  drawdownLossMultiple: number;
  maxPlausibleMultiple: number;
}

/** Running record of the price path, kept in Redis between peeks. */
export interface PathState {
  /** Best / worst multiple seen so far (vs the evaluation price). */
  max: number;
  min: number;
  /** Minute of the peek at which max last rose (≈ time to peak, upper bound). */
  peakAtMin: number | null;
  /** First peek where max ≥ win multiple / min ≤ drawdown multiple. */
  winAtMin: number | null;
  lossAtMin: number | null;
}

export const emptyPath = (): PathState => ({ max: 1, min: 1, peakAtMin: null, winAtMin: null, lossAtMin: null });

/** Fold one peek (cumulative window max/min, as multiples) into the path. Pure. */
export function updatePath(p: PathState, maxMultiple: number, minMultiple: number, minute: number, o: LabelOptions): PathState {
  const next = { ...p };
  if (Number.isFinite(maxMultiple) && maxMultiple > next.max) {
    next.max = maxMultiple;
    next.peakAtMin = minute;
  }
  if (Number.isFinite(minMultiple) && minMultiple > 0 && minMultiple < next.min) next.min = minMultiple;
  if (next.winAtMin === null && next.max >= o.winMultiple) next.winAtMin = minute;
  if (next.lossAtMin === null && next.min <= o.drawdownLossMultiple) next.lossAtMin = minute;
  return next;
}

/** What gets stored on the evaluation as `features.outcome`. */
export interface PriceOutcome {
  win: boolean;
  peak: number;
  min: number;
  timeToPeakMin: number | null;
  /** Worst drop below the evaluation price, % (0 = never dipped). */
  maxDrawdownPct: number;
  winAtMin: number | null;
  lossAtMin: number | null;
  excluded: ExcludeReason | null;
  /** True when the path was not sampled (old pending job) → ordering unknown. */
  coarse?: boolean;
}

/** Turn a finished path into a label. Pure. */
export function labelFromPath(p: PathState, o: LabelOptions, coarse = false): PriceOutcome {
  let win: boolean;
  if (p.winAtMin === null) win = false;
  else if (p.lossAtMin === null) win = true;
  // Both crossed: win only if the win came strictly first (same peek → can't tell → loss).
  else win = p.winAtMin < p.lossAtMin;
  return {
    win,
    peak: round4(p.max),
    min: round4(p.min),
    timeToPeakMin: p.peakAtMin,
    maxDrawdownPct: round2(Math.max(0, (1 - p.min) * 100)),
    winAtMin: p.winAtMin,
    lossAtMin: p.lossAtMin,
    excluded: p.max > o.maxPlausibleMultiple ? 'implausible_multiple' : null,
    ...(coarse ? { coarse: true } : {}),
  };
}

/** Realised result of the trade we made on this evaluation (`features.tradeResult`). */
export interface TradeOutcome {
  win: boolean;
  pnlSol: number;
  /** P&L after all fees as % of the stake. */
  pnlPct: number;
  peakMultiple: number | null;
  closedAt: string;
  excluded: ExcludeReason | null;
}

/** Pure: build a trade outcome. */
export function tradeOutcome(i: { realizedPnlSol: number; sizeSol: number; peakMultiple: number | null; closedAt: Date; suspicious: boolean }, o: LabelOptions): TradeOutcome {
  const pnlPct = i.sizeSol > 0 ? (i.realizedPnlSol / i.sizeSol) * 100 : 0;
  let excluded: ExcludeReason | null = null;
  if (i.suspicious) excluded = 'suspicious_fill';
  else if (pnlPct / 100 + 1 > o.maxPlausibleMultiple || (i.peakMultiple ?? 0) > o.maxPlausibleMultiple) excluded = 'implausible_multiple';
  return { win: i.realizedPnlSol > 0, pnlSol: round4(i.realizedPnlSol), pnlPct: round2(pnlPct), peakMultiple: i.peakMultiple === null ? null : round4(i.peakMultiple), closedAt: i.closedAt.toISOString(), excluded };
}

/** The minimal slice of a stored evaluation the resolver needs. */
export interface LabelRow {
  outcome?: Partial<PriceOutcome> | null;
  tradeResult?: Partial<TradeOutcome> | null;
  outcomeMax: number | null;
  outcomeMin: number | null;
  createdAt: Date;
  mint: string;
}

export interface ResolvedLabel {
  win: boolean;
  /** 'trade' = our realised P&L; 'price' = price-path label. */
  source: 'trade' | 'price';
}

export interface ResolveContext extends LabelOptions {
  /** Last paper reset — nothing before it is learnt from. */
  since: Date | null;
  /** Mints with a suspicious_fill event. */
  suspiciousMints: ReadonlySet<string>;
}

/**
 * Pure: final label for one evaluation, or the reason it's excluded.
 * Realised trade result first, then the risk-aware price label, then (for rows
 * labelled before this version) a conservative fallback on max/min.
 */
export function resolveLabel(r: LabelRow, c: ResolveContext): ResolvedLabel | { excluded: ExcludeReason } {
  if (c.since && r.createdAt < c.since) return { excluded: 'before_reset' };
  if (c.suspiciousMints.has(r.mint)) return { excluded: 'suspicious_fill' };
  if (r.outcome?.excluded) return { excluded: r.outcome.excluded };
  if ((r.outcomeMax ?? 0) > c.maxPlausibleMultiple) return { excluded: 'implausible_multiple' };
  const t = r.tradeResult;
  if (t && typeof t.win === 'boolean') {
    if (t.excluded) return { excluded: t.excluded };
    return { win: t.win, source: 'trade' };
  }
  if (r.outcome && typeof r.outcome.win === 'boolean') return { win: r.outcome.win, source: 'price' };
  // Legacy rows (only max/min, no ordering): win only if it never hit the drawdown floor.
  return { win: (r.outcomeMax ?? 0) >= c.winMultiple && (r.outcomeMin ?? 1) > c.drawdownLossMultiple, source: 'price' };
}

/** Redis key the paper-reset route writes (ISO string). */
export const PAPER_RESET_KEY = 'paper:resetAt';

/** When learning data starts: the last paper reset, or null. Never throws. */
export async function learningSince(redis: Pick<Redis, 'get'>): Promise<Date | null> {
  try {
    const v = await redis.get(PAPER_RESET_KEY);
    if (!v) return null;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
