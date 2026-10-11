/**
 * Shadow trades (owner: "speed up the learning"): pretend trades on coins the bot did NOT buy,
 * so it learns several times faster than from its own trades alone.
 *
 *   refused  — the bot wanted to buy, the trader said no (positions full, budget, rug screen, …)
 *   near     — every rule passed, the score was just under the bar
 *   skipped  — a rule said no (top-10 too high, fake volume, AI rule, …) but the score was close
 *
 * Each one is followed with the bot's own exits and costs (virtual-book.ts) — no balance is used,
 * nothing shows up as a position. The result (+ the coin's entry features) is kept in Redis
 * (`shadow:res`, newest first). The loss autopsy, the best-times learner and the AI coach read
 * them next to the real trades (refused + near only, at half weight — those are trades the bot
 * would have taken); the "skipped" ones answer "what do my filters cost?" per rule.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG, type BotConfigShape } from '../config/default';
import { getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import { moduleLogger } from '../lib/logger';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { VirtualBook, type VirtualResult } from './virtual-book';
import type { ClosedTrade } from './loss-autopsy';

const log = moduleLogger('shadow');
const RES = 'shadow:res';

export type ShadowKind = 'refused' | 'near' | 'skipped';
export type ShadowConfig = BotConfigShape['shadow'];

export interface ShadowSignal {
  mint: string;
  symbol: string;
  strategy: StrategyName;
  kind: ShadowKind;
  /** Why it wasn't bought (refusal / first failed rule / "score under the bar"). */
  why: string;
  score: number;
  bar: number;
  priceSol: number;
  onAmm: boolean;
  mcUsd: number | null;
  ageMin: number | null;
  curvePct: number | 'migrated' | null;
  kols: number | null;
  run3m: number | null;
  offHigh10m: number | null;
  /** Flat entry features (ai-coach flattenFeatures) so AI rules can be tested on it. */
  flat: Record<string, number>;
}

export interface ShadowResult extends Omit<ShadowSignal, 'priceSol' | 'onAmm'> {
  openedAtMs: number;
  closedAtMs: number;
  pnlPct: number;
  peakX: number;
  holdSec: number;
  exitReason: string;
}

/** Pure: group key for a "why" — numbers dropped so "top 10 hold 52% (> 50%)" and "… 61% …" are one filter. */
export function whyKey(why: string): string {
  return (
    why
      .replace(/\(.*?\)/g, '')
      .replace(/[−-]?\$?\d+(?:[.,]\d+)?\s*(?:%|x|k|m|sol|s|min|h)?/gi, '#')
      .replace(/(#\s*)+/g, '# ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'other'
  );
}

export interface ShadowGroup {
  key: string;
  /** One real "why" of the group (readable, with its numbers). */
  example: string;
  n: number;
  avgPct: number;
  winRatePct: number;
  /** % that went 2x or more at some point. */
  went2xPct: number;
  best: Array<{ symbol: string; peakX: number; pnlPct: number }>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function group(key: string, rows: readonly ShadowResult[]): ShadowGroup {
  const n = rows.length;
  return {
    key,
    example: rows[0]?.why ?? key,
    n,
    avgPct: n ? r1(rows.reduce((s, r) => s + r.pnlPct, 0) / n) : 0,
    winRatePct: n ? Math.round((rows.filter((r) => r.pnlPct > 0).length / n) * 100) : 0,
    went2xPct: n ? Math.round((rows.filter((r) => r.peakX >= 2).length / n) * 100) : 0,
    best: [...rows].sort((a, b) => b.peakX - a.peakX).slice(0, 3).map((r) => ({ symbol: r.symbol, peakX: r1(r.peakX), pnlPct: r1(r.pnlPct) })),
  };
}

export interface ShadowReport {
  total: number;
  open: number;
  byKind: Record<ShadowKind, ShadowGroup>;
  byStrategy: ShadowGroup[];
  /** Skipped coins grouped by the rule that skipped them: what each filter costs (or saves). */
  byRule: ShadowGroup[];
  /** Refused buy signals grouped by why the trader said no. */
  byRefusal: ShadowGroup[];
  findings: string[];
  missed: ShadowResult[];
  recent: ShadowResult[];
}

/** Pure: the report the dashboard / AI read. */
export function shadowReport(rows: readonly ShadowResult[], open: number, minGroup = 10): ShadowReport {
  const kinds: ShadowKind[] = ['refused', 'near', 'skipped'];
  const byKind = Object.fromEntries(kinds.map((k) => [k, group(k, rows.filter((r) => r.kind === k))])) as Record<ShadowKind, ShadowGroup>;
  const groups = (rs: readonly ShadowResult[], key: (r: ShadowResult) => string) => {
    const m = new Map<string, ShadowResult[]>();
    for (const r of rs) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m.entries()].map(([k, g]) => group(k, g)).sort((a, b) => b.n - a.n);
  };
  const byRule = groups(rows.filter((r) => r.kind === 'skipped'), (r) => whyKey(r.why));
  const byRefusal = groups(rows.filter((r) => r.kind === 'refused'), (r) => whyKey(r.why));
  const byStrategy = groups(rows, (r) => r.strategy);
  const findings: string[] = [];
  if (rows.length < 20) findings.push(`Only ${rows.length} shadow trades so far — keep collecting.`);
  for (const g of byRule.filter((x) => x.n >= minGroup)) {
    if (g.avgPct >= 5) findings.push(`The filter "${g.example}" skipped ${g.n} coins that would have averaged +${g.avgPct}% (${g.went2xPct}% went 2x+) — it may be costing money.`);
    else if (g.avgPct <= -8) findings.push(`The filter "${g.example}" is saving money: its ${g.n} skipped coins would have averaged ${g.avgPct}%.`);
  }
  const ref = byKind.refused;
  if (ref.n >= minGroup && ref.avgPct >= 5) findings.push(`Buy signals the bot had no room for would have averaged +${ref.avgPct}% (${ref.n}) — more open positions or budget would pay.`);
  const near = byKind.near;
  if (near.n >= minGroup) findings.push(near.avgPct >= 3 ? `Coins just under the score bar would have averaged +${near.avgPct}% (${near.n}) — the bar may be too strict.` : `Coins just under the score bar would have averaged ${near.avgPct}% (${near.n}) — the bar is doing its job.`);
  return {
    total: rows.length,
    open,
    byKind,
    byStrategy,
    byRule: byRule.slice(0, 20),
    byRefusal: byRefusal.slice(0, 10),
    findings,
    missed: [...rows].filter((r) => r.peakX >= 2).sort((a, b) => b.peakX - a.peakX).slice(0, 15),
    recent: rows.slice(0, 40),
  };
}

/** Shadow trades the bot WOULD have taken (refused + near) — what the learners count next to real trades. */
export const wouldHaveTaken = (r: Pick<ShadowResult, 'kind'>) => r.kind === 'refused' || r.kind === 'near';

export class ShadowTrades {
  private readonly book: VirtualBook;
  private readonly last = new Map<string, number>();
  private readonly pending = new Map<string, ShadowSignal & { openedAtMs: number }>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(
    private readonly redis: Redis,
    crowd: CrowdTracker,
  ) {
    this.book = new VirtualBook(
      crowd,
      (_tag, live) => live,
      (r) => this.save(r),
      () => this.cfg().maxOpen,
    );
  }

  private cfg(): ShadowConfig {
    return getConfig().shadow ?? DEFAULT_CONFIG.shadow;
  }

  start(): void {
    this.timer = setInterval(() => this.book.stepAll(), 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get openCount(): number {
    return this.book.size;
  }

  /** A coin the bot didn't buy (see the kinds above). Opens one shadow trade per coin + strategy per cooldown. */
  onSignal(s: ShadowSignal, now = Date.now()): boolean {
    const c = this.cfg();
    if (!c.enabled || !(s.priceSol > 0)) return false;
    if (s.kind === 'skipped' && s.score < s.bar - c.skipWithinPoints) return false;
    // Room is kept for the trades the bot wanted most: skipped ones only while the book is under 80% full.
    if (s.kind === 'skipped' && this.book.size >= c.maxOpen * 0.8) return false;
    const k = `${s.mint}:${s.strategy}`;
    const prev = this.last.get(k);
    if (prev !== undefined && now - prev < c.cooldownMin * 60_000) return false;
    const key = `sh:${++this.seq}:${k}`;
    const ok = this.book.add({ key, mint: s.mint, symbol: s.symbol, strategy: s.strategy, onAmm: s.onAmm, priceSol: s.priceSol, tag: { id: key } }, now);
    if (!ok) return false;
    this.last.set(k, now);
    if (this.last.size > 20_000) for (const [x, t] of this.last) if (now - t > c.cooldownMin * 60_000) this.last.delete(x);
    this.pending.set(key, { ...s, openedAtMs: now });
    return true;
  }

  onTrade(mint: string, now = Date.now()): void {
    this.book.onTrade(mint, now);
  }

  private save(v: VirtualResult): void {
    const s = this.pending.get(String(v.tag.id));
    this.pending.delete(String(v.tag.id));
    if (!s) return;
    const { priceSol: _p, onAmm: _a, ...rest } = s;
    const r: ShadowResult = { ...rest, closedAtMs: v.at, pnlPct: r1(v.pnlPct), peakX: Math.round(v.peakX * 100) / 100, holdSec: Math.round(v.holdSec), exitReason: v.reason };
    void this.redis
      .multi()
      .lpush(RES, JSON.stringify(r))
      .ltrim(RES, 0, this.cfg().keep - 1)
      .exec()
      .catch((err: Error) => log.warn({ err: err.message }, 'shadow result not saved'));
  }

  /** Closed shadow trades, newest first (optionally only since `sinceMs`). */
  async results(sinceMs = 0, limit?: number): Promise<ShadowResult[]> {
    const raw = await this.redis.lrange(RES, 0, (limit ?? this.cfg().keep) - 1);
    const out: ShadowResult[] = [];
    for (const x of raw) {
      try {
        const r = JSON.parse(x) as ShadowResult;
        if (r.openedAtMs >= sinceMs) out.push(r);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async report(sinceMs = 0): Promise<ShadowReport> {
    return shadowReport(await this.results(sinceMs), this.book.size);
  }
}

/** Pure: a shadow trade in the loss autopsy's shape (SOL scaled to `weight` × the minimum size). */
export function shadowAsClosed(r: ShadowResult, weight: number, minSizeSol: number): ClosedTrade {
  const sizeSol = minSizeSol * weight;
  const d = new Date(r.openedAtMs);
  return {
    strategy: r.strategy,
    mcUsd: r.mcUsd,
    ageMin: r.ageMin,
    curvePct: r.curvePct,
    score: r.score,
    hourUtc: d.getUTCHours(),
    dowUtc: d.getUTCDay(),
    kols: r.kols,
    run3m: r.run3m,
    offHigh10m: r.offHigh10m,
    pnlSol: (r.pnlPct / 100) * sizeSol,
    pnlPct: r.pnlPct,
    sizeSol,
    exitReason: r.exitReason,
    peakMultiple: r.peakX,
    heldMin: r.holdSec / 60,
    explore: false,
    shadow: true,
  };
}
