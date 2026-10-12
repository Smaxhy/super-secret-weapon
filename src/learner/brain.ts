/**
 * The brain — runs the self-improving learners on ONE shared training set (learn-rows.ts: real + shadow trades)
 * and wires their conclusions into trading:
 *
 *   win model (win-model.ts)        P(win) per coin from its features — only used once it beats the score on newer
 *                                   trades; shifts the buy bar by up to ±10 points
 *   rule search (policy-search.ts)  finds entry rules with proper statistics (holdout + false-discovery control) →
 *                                   they join the AI coach's rules as 'testing' and only go live after they hold up
 *                                   on NEW trades
 *   allocator (allocator.ts)        moves budget between strategies by how likely each really makes money
 *
 * Every switch (model on/off, rules found, budget moves) goes into the change log. `snapshot()` feeds the Brain
 * page and the AI coach's "otherLearners" section.
 */
import type { Redis } from 'ioredis';
import { getConfig } from '../config/runtime-config';
import { recentChanges, recordChange } from '../lib/change-log';
import { moduleLogger } from '../lib/logger';
import type { AiCoach } from './ai-coach';
import { Allocator } from './allocator';
import { entryStyleFor } from './entry-style';
import { LearnRows } from './learn-rows';
import { PolicySearch } from './policy-search';
import type { ShadowResult } from './shadow-trades';
import type { OutcomeResult } from './outcome-tracker';
import { WinModel } from './win-model';
import type { TimerVerdict } from './exit-tuner';

const log = moduleLogger('brain');
const STRATS = ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SWING', 'RUNNER'];

export class Brain {
  readonly rows: LearnRows;
  readonly model: WinModel;
  readonly search: PolicySearch;
  readonly alloc: Allocator;
  private timers: NodeJS.Timeout[] = [];
  private lastActive: boolean | null = null;
  private lastMult = new Map<string, number>();
  /** What coins did after time-based exits (exit-tuner.ts) — set in index.ts. */
  exitSource: (() => { at: string; verdicts: TimerVerdict[] } | null) | null = null;

  /** What the coins it didn't buy did (outcome-tracker.ts) — set in index.ts. */
  outcomeSource: (() => Promise<unknown>) | null = null;

  constructor(
    redis: Redis,
    shadowSource: (sinceMs: number) => Promise<ShadowResult[]>,
    private readonly coach: AiCoach,
    outcomeSource: ((sinceMs: number) => Promise<OutcomeResult[]>) | null = null,
  ) {
    this.rows = new LearnRows(redis, shadowSource, outcomeSource);
    this.model = new WinModel(redis, () => this.rows.load());
    this.search = new PolicySearch(() => this.rows.load());
    this.alloc = new Allocator(redis, () => this.rows.load({ onlyTaken: true }), () => getConfig().trading.allocation as Record<string, number>);
  }

  start(): void {
    this.model.start();
    this.alloc.start();
    // Rule search: own schedule so its findings go straight into the testing pipeline.
    const searchTick = () => void this.runSearch();
    this.timers.push(setTimeout(searchTick, 6 * 60_000), setInterval(searchTick, 60 * 60_000));
    // Watch the model + allocator for changes worth telling the owner about.
    const watch = () => void this.watch();
    this.timers.push(setTimeout(watch, 4 * 60_000), setInterval(watch, 15 * 60_000));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.model.stop();
    this.alloc.stop();
    this.search.stop();
  }

  /** Budget multiplier for a strategy (1 until the allocator has enough evidence). */
  allocFactor(strategy: string): number {
    const m = this.alloc.multiplierFor(strategy);
    return Number.isFinite(m) && m > 0 ? m : 1;
  }

  async runSearch(): Promise<number> {
    try {
      const res = await this.search.run();
      if (!res?.rules.length) return 0;
      const added = await this.coach.addDiscoveredRules(res.rules);
      if (added) {
        await this.coach.refreshRules();
        void recordChange({
          source: 'rule-search',
          strategy: null,
          what: `Found ${added} new entry rule${added > 1 ? 's' : ''} in past trades — testing on new trades now`,
          why: res.rules.slice(0, added).map((r) => r.title).join(' · '),
        });
      }
      return added;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'rule search step failed');
      return 0;
    }
  }

  private async watch(): Promise<void> {
    try {
      const m = this.model.snapshot();
      if (m && this.lastActive !== null && m.active !== this.lastActive) {
        void recordChange({
          source: 'win-model',
          strategy: null,
          what: m.active ? `Win-probability model switched ON (${m.using === 'both' ? 'straight-line + tree models together' : m.using === 'trees' ? 'tree model' : 'straight-line model'}) — it now shifts the buy bar` : 'Win-probability model switched off',
          why: m.active ? 'it predicts winners better than the score on the newest trades' : (m.report?.reason ?? m.tree?.report.reason ?? 'it no longer beats the score on the newest trades'),
        });
      }
      if (m) this.lastActive = m.active;
      const a = this.alloc.snapshot();
      if (a) {
        for (const s of a.strategies) {
          const prev = this.lastMult.get(s.strategy);
          if (prev !== undefined && Math.abs(prev - s.multiplier) >= 0.1) {
            void recordChange({ source: 'allocator', strategy: s.strategy, what: `${s.strategy} budget ×${prev.toFixed(2)} → ×${s.multiplier.toFixed(2)}`, why: s.why });
          }
          this.lastMult.set(s.strategy, s.multiplier);
        }
      }
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'brain watch failed');
    }
  }

  /** Everything the learners know right now (Brain page + AI coach). */
  async snapshot(compact = false): Promise<Record<string, unknown>> {
    const m = this.model.snapshot();
    const s = this.search.last();
    const a = this.alloc.snapshot();
    const rules = await this.coach.rules().catch(() => []);
    const fromSearch = rules.filter((r) => r.source === 'search');
    return {
      model: m
        ? {
            active: m.active,
            using: m.using,
            trainedAt: new Date(m.trainedAtMs).toISOString(),
            report: m.report ? (compact ? { reason: m.report.reason, valAuc: m.report.valAuc, baselineAuc: m.report.baselineAuc } : m.report) : null,
            explain: m.explain.slice(0, compact ? 6 : 10),
            tree: m.tree
              ? { active: m.tree.active, report: compact ? { reason: m.tree.report.reason, valAuc: m.tree.report.valAuc, baselineAuc: m.tree.report.baselineAuc, trees: m.tree.report.trees } : m.tree.report, explain: m.tree.explain.slice(0, compact ? 6 : 10) }
              : null,
          }
        : null,
      search: s ? { ranAt: s.ranAt, rows: s.rows, tested: s.tested, found: s.rules.length, rules: compact ? s.rules.map((r) => r.title) : s.rules } : null,
      discoveredRules: fromSearch.map((r) => ({ title: r.title, status: r.status, statusWhy: r.statusWhy, forward: r.forward, backtest: r.backtest })),
      allocation: a ? a.strategies.map((x) => (compact ? { strategy: x.strategy, multiplier: x.multiplier, why: x.why } : x)) : null,
      entryStyles: STRATS.flatMap((st) => {
        const e = entryStyleFor(st);
        return e ? [e] : [];
      }),
      exitTimers: this.exitSource?.()?.verdicts.slice(0, compact ? 8 : 30) ?? [],
      coinsChecked: this.outcomeSource ? await this.outcomeSource().catch(() => null) : null,
      changes: (await recentChanges(compact ? 12 : 40).catch(() => [])).map((c) => (compact ? `${c.at.slice(0, 16)} ${c.what}` : c)),
    };
  }
}
