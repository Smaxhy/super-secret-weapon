/**
 * v27.23 loss review (owner: "any time a loss happens that's not a bug, analyse it thoroughly and make sure it doesn't
 * happen again"). Every losing bot close is graded against the lab's own paper trade with the same identity (its ref =
 * `tradeKey`) — the trade the strategy was tested on:
 * - normal: the tested trade lost too → part of the strategy's record (the learner and the per-market records act on it)
 * - avoidable: the bot did something the test didn't — doubled the bet with another strategy on the same market and
 *   direction, was cut by the USD loss cap while the tested trade survived, or simply ended worse than the tested trade
 * - pending: the tested trade is still running (graded again later); unknown: no tested trade found after 3 days
 * Pure: the lab stores the reviews (Redis `fx:lossrev` / `cm:lossrev`) and writes one bot-log line per finished review.
 */
import type { ClosedPractice, PracticePosition } from './practice';
import type { Trade } from './types';

export type LossVerdict = 'normal' | 'avoidable' | 'pending' | 'unknown';
export type LossCause = 'tested_loss' | 'doubled' | 'loss_cap' | 'worse_than_test' | 'no_test' | 'test_running';

export interface LossReview {
  id: string;
  ref: string | null;
  pair: string;
  strategy: string | null;
  tf: string | null;
  side: 1 | -1;
  closedAt: number;
  usd: number;
  /** R on the risk it opened with (null when unknown) */
  r: number | null;
  verdict: LossVerdict;
  causes: LossCause[];
  /** the tested (lab) trade: its R when finished, null while running / not found */
  testR: number | null;
  testReason: string | null;
  /** loss-cap stops only: USD the cap saved (+) or cost (−) vs the tested trade's result at the original stop's size */
  capDelta?: number;
  /** plain words */
  why: string;
  /** what stops it happening again (only for avoidable losses) */
  fix: string | null;
  at: number;
}

export const LOSS_REVIEW = {
  keep: 150,
  /** give up looking for the tested trade after this long */
  unknownAfterMs: 3 * 86_400_000,
  /** a stop within this share of the cap counts as a cap stop */
  capSlack: 0.15,
};

const tfOf = (c: { tf?: string | null; ref?: string | null }) => c.tf ?? (c.ref ? c.ref.split(':')[1] ?? null : null);
const money = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const rTxt = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;

/** Was another trade on the same market and direction open at the same time (a doubled bet)? Pure. */
export function doubledWith(c: ClosedPractice, closed: readonly ClosedPractice[], open: readonly PracticePosition[]): string | null {
  for (const o of [...closed, ...open]) {
    if (o.id === c.id || o.id.startsWith(`${c.id}-part`) || c.id.startsWith(`${o.id}-part`)) continue;
    if (o.pair !== c.pair || o.side !== c.side) continue;
    if ('reason' in o && (o.reason === 'partial' || o.reason === 'weekend')) continue;
    const oEnd = 'closedAt' in o ? (o as ClosedPractice).closedAt : Infinity;
    if (o.openedAt < c.closedAt && oEnd > c.openedAt) return o.strategy ?? 'another trade';
  }
  return null;
}

/** Grade one losing close. Pure. */
export function reviewLoss(c: ClosedPractice, ctx: { closed: readonly ClosedPractice[]; open: readonly PracticePosition[]; labDone: ReadonlyMap<string, Trade>; labOpen: ReadonlySet<string>; maxLossUsd?: number; now: number }): LossReview {
  const r = c.riskUsd0 && c.riskUsd0 > 0 ? Math.round((c.pnlUsd / c.riskUsd0) * 100) / 100 : null;
  const base = { id: c.id, ref: c.ref ?? null, pair: c.pair, strategy: c.strategy ?? null, tf: tfOf(c), side: (c.side === -1 ? -1 : 1) as 1 | -1, closedAt: c.closedAt, usd: c.pnlUsd, r, at: ctx.now };
  const causes: LossCause[] = [];
  const twin = c.ref ? ctx.labDone.get(c.ref) : undefined;
  const testR = twin ? Math.round(twin.r * 100) / 100 : null;
  const dup = doubledWith(c, ctx.closed, ctx.open);
  const cap = ctx.maxLossUsd && c.reason === 'stop' && (c.riskUsd0 ?? 0) > ctx.maxLossUsd * (1 + LOSS_REVIEW.capSlack) && Math.abs(c.pnlUsd) <= ctx.maxLossUsd * (1 + LOSS_REVIEW.capSlack);
  if (dup) causes.push('doubled');
  if (!twin) {
    const running = !!c.ref && ctx.labOpen.has(c.ref);
    if (running || ctx.now - c.closedAt < LOSS_REVIEW.unknownAfterMs) {
      return { ...base, verdict: dup ? 'avoidable' : 'pending', causes: [...causes, 'test_running'], testR: null, testReason: null, why: running ? 'the tested trade is still running — graded when it ends' : 'waiting for the tested trade to show up', fix: dup ? fixFor('doubled') : null };
    }
    return { ...base, verdict: dup ? 'avoidable' : 'unknown', causes: [...causes, 'no_test'], testR: null, testReason: null, why: 'no tested trade with the same signal was found', fix: dup ? fixFor('doubled') : null };
  }
  const capDelta = cap && c.riskUsd0 ? Math.round((c.pnlUsd - twin.r * c.riskUsd0) * 100) / 100 : undefined;
  if (cap && twin.r > -0.5) causes.push('loss_cap');
  const lostToo = twin.r < 0;
  if (!lostToo && !cap) causes.push('worse_than_test');
  if (lostToo && !dup) {
    causes.unshift('tested_loss');
    return { ...base, verdict: 'normal', causes, testR, testReason: twin.reason, ...(capDelta !== undefined ? { capDelta } : {}), why: `the tested strategy lost this trade too (${rTxt(twin.r)}, ${twin.reason}) — part of its record, no rule broken`, fix: null };
  }
  const parts: string[] = [];
  if (dup) parts.push(`${dup} was already in the same ${c.side === 1 ? 'buy' : 'sell'} on ${c.pair} — the bet was doubled`);
  if (causes.includes('loss_cap')) parts.push(`the ${money(-(ctx.maxLossUsd ?? 0))} loss cap stopped it while the tested trade ${twin.r >= 0 ? `won ${rTxt(twin.r)}` : `only lost ${rTxt(twin.r)}`}`);
  if (causes.includes('worse_than_test')) parts.push(`the tested trade ended ${rTxt(twin.r)} (${twin.reason}) but the bot's copy lost ${money(c.pnlUsd)} — its entry / exit differed from the test`);
  if (lostToo && dup) parts.push(`the tested trade lost too (${rTxt(twin.r)})`);
  const main = causes.find((x) => x !== 'tested_loss') ?? 'worse_than_test';
  return { ...base, verdict: 'avoidable', causes, testR, testReason: twin.reason, ...(capDelta !== undefined ? { capDelta } : {}), why: parts.join('; '), fix: fixFor(main) };
}

function fixFor(cause: LossCause): string {
  if (cause === 'doubled') return 'one bet per market and direction (on since v27.23): a second strategy firing the same way waits';
  if (cause === 'loss_cap') return 'counted in the cap check: if cap cuts cost more than the cap saves, the cap is reported as too tight';
  return 'counted per strategy and chart: the restricted learner halves / drops a strategy whose bot record keeps losing';
}

/** Review every losing close not yet finished; keeps finished reviews, re-grades pending ones. Pure. */
export function reviewLosses(prev: readonly LossReview[], ctx: Parameters<typeof reviewLoss>[1]): { reviews: LossReview[]; finished: LossReview[] } {
  const byId = new Map(prev.map((x) => [x.id, x]));
  const finished: LossReview[] = [];
  for (const c of ctx.closed) {
    if (c.pnlUsd >= 0 || c.reason === 'manual' || c.reason === 'partial' || c.reason === 'weekend' || !c.strategy) continue;
    const old = byId.get(c.id);
    if (old && old.verdict !== 'pending') continue;
    const r = reviewLoss(c, ctx);
    byId.set(c.id, r);
    if (r.verdict !== 'pending') finished.push(r);
  }
  const live = new Set(ctx.closed.map((c) => c.id));
  // a struck / undone trade disappears from the closed list → its review goes too
  const reviews = [...byId.values()].filter((x) => live.has(x.id) || ctx.now - x.closedAt > 14 * 86_400_000).sort((a, b) => b.closedAt - a.closedAt).slice(0, LOSS_REVIEW.keep);
  return { reviews, finished };
}

/** Totals for the API / dashboard: verdict counts, USD by cause, and whether the loss cap pays for itself. Pure. */
export function lossSummary(reviews: readonly LossReview[]) {
  const capSavedUsd = Math.round(reviews.reduce((n, x) => n + (x.capDelta ?? 0), 0) * 100) / 100;
  const by: Record<LossVerdict, { n: number; usd: number }> = { normal: { n: 0, usd: 0 }, avoidable: { n: 0, usd: 0 }, pending: { n: 0, usd: 0 }, unknown: { n: 0, usd: 0 } };
  const causes: Record<string, { n: number; usd: number }> = {};
  for (const x of reviews) {
    by[x.verdict].n++;
    by[x.verdict].usd = Math.round((by[x.verdict].usd + x.usd) * 100) / 100;
    for (const c of x.causes) {
      const k = (causes[c] ??= { n: 0, usd: 0 });
      k.n++;
      k.usd = Math.round((k.usd + x.usd) * 100) / 100;
    }
  }
  const capStops = reviews.filter((x) => x.capDelta !== undefined).length;
  return { by, causes, capSavedUsd, capStops, capVerdict: capStops >= 5 && capSavedUsd < 0 ? 'the loss cap is costing money: its stops cut trades the test kept' : capStops ? 'the loss cap is paying for itself so far' : null, newest: reviews.slice(0, 20) };
}

