/**
 * AI coach (owner: "learn not only pure statistics but also the behaviours it sees").
 *
 * Every hour (when enough new trades closed) Claude reads the bot's recent trades the way a trader
 * would — the market + crowd + launch-flow picture at entry, why it bought, how it ended, the coach's
 * lesson — and writes back:
 *   - plain-language INSIGHTS (shown on the Performance page)
 *   - candidate RULES over the bot's own measurable features ("avoid CURVE_SNIPE when crowd.paperHandsPct > 40")
 *
 * A rule is never trusted on the AI's word. It is checked on the past trades (backtest — disagrees →
 * retired at once), then FORWARD-tested on new trades while it only records matches; it goes live only
 * when the new trades prove it (avoid: matching trades ≥5 pts worse and still negative after one SE;
 * prefer: ≥5 pts better and positive), and is retired when it stops working. Live avoid rules refuse
 * the buy (1 in 5 still goes through small so the evidence keeps coming); live prefer rules lower the bar.
 *
 * Cost control: ANTHROPIC_API_KEY only in the VPS .env; AI_DAILY_BUDGET_USD (default 0.5) hard daily cap,
 * counted from each response's real token usage; no call without new trades to read.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Redis } from 'ioredis';
import { applyEdit } from '../config/apply-edit';
import { EDITABLE, getPath } from '../config/editable';
import { getConfig } from '../config/runtime-config';
import { prisma } from '../lib/prisma';
import { moduleLogger } from '../lib/logger';
import { learningSince } from './labels';
import { recordChange } from '../lib/change-log';
import { DAY_NAMES, type TimingProfile } from './timing';
import { wouldHaveTaken, type ShadowReport, type ShadowResult } from './shadow-trades';
import type { Autopsy } from './loss-autopsy';
import { readHistory } from '../executor/position-history';
import { afterEntry } from '../evaluator/price-shape';

const log = moduleLogger('ai-coach');
const TIP_MAX = 30;

export interface AiRuleCondition {
  feature: string;
  op: 'lt' | 'gt';
  value: number;
}

export interface RuleStats {
  n: number;
  avgPct: number;
  sePct: number;
  restAvgPct: number;
}

export interface AiRule {
  id: string;
  title: string;
  why: string;
  /** null = any strategy. */
  strategy: string | null;
  action: 'avoid' | 'prefer';
  conditions: AiRuleCondition[];
  createdAt: string;
  status: 'testing' | 'live' | 'retired';
  statusWhy: string;
  backtest: RuleStats | null;
  forward: RuleStats | null;
  /** Who proposed it: the AI coach (default), the statistical rule search (policy-search.ts) or the owner's tip. */
  source?: 'ai' | 'search' | 'owner';
  /** The owner's tip this rule came from (owner rules go live at once and stay live until the tip is removed). */
  tipId?: string;
}

/** A tip the owner gave the brain ("talk to it") — the AI turns it into rules / setting changes and answers. */
export interface OwnerTip {
  id: string;
  at: string;
  text: string;
  status: 'new' | 'done';
  response: string | null;
  rules: string[];
  settings: string[];
  answeredAt: string | null;
}

export interface AiCoachConfig {
  enabled: boolean;
  everyMin: number;
  minNewTrades: number;
  tradesPerReview: number;
  maxRules: number;
  /** Forward trades needed before a rule can go live / be retired. */
  minForward: number;
  /** Points better / worse than the rest a rule's trades must be. */
  edgePct: number;
  probeEvery: number;
  preferBarDelta: number;
}

// ---------------------------------------------------------------------------
// Features: one flat map of numbers per trade (same shape at entry and in the backtest)
// ---------------------------------------------------------------------------

const SECTIONS = ['market', 'shape', 'tf', 'pa', 'x', 'crowd', 'manipulation', 'newPair', 'trending', 'kol', 'chart', 'swing', 'pressure'] as const;

/** Pure: numeric (and boolean → 0/1) leaves of the evaluation features, namespaced, ≤3 levels deep. */
export function flattenFeatures(features: unknown, extra: Record<string, number | null | undefined> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 3 || v === null || v === undefined) return;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[path] = v;
    } else if (typeof v === 'boolean') out[path] = v ? 1 : 0;
    else if (typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  const f = (features ?? {}) as Record<string, unknown>;
  for (const s of SECTIONS) walk(f[s], s, 0);
  for (const [k, v] of Object.entries(extra)) if (typeof v === 'number' && Number.isFinite(v)) out[`entry.${k}`] = v;
  return out;
}

/** Pure: does a rule match this trade / candidate? A missing feature never matches. */
export function matchRule(rule: Pick<AiRule, 'strategy' | 'conditions'>, strategy: string, flat: Readonly<Record<string, number>>): boolean {
  if (rule.strategy && rule.strategy !== strategy) return false;
  if (!rule.conditions.length) return false;
  return rule.conditions.every((c) => {
    const v = flat[c.feature];
    return v !== undefined && (c.op === 'lt' ? v < c.value : v > c.value);
  });
}

export interface CoachTrade {
  strategy: string;
  pnlPct: number;
  openedAtMs: number;
  flat: Record<string, number>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Pure: how trades matching the rule did vs the rest (same strategy scope). */
export function ruleStats(rule: Pick<AiRule, 'strategy' | 'conditions'>, trades: readonly CoachTrade[]): RuleStats | null {
  const scope = trades.filter((t) => !rule.strategy || t.strategy === rule.strategy);
  const m = scope.filter((t) => matchRule(rule, t.strategy, t.flat)).map((t) => t.pnlPct);
  const rest = scope.filter((t) => !matchRule(rule, t.strategy, t.flat)).map((t) => t.pnlPct);
  if (!m.length) return null;
  const mean = m.reduce((a, b) => a + b, 0) / m.length;
  const sd = m.length > 1 ? Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / (m.length - 1)) : 0;
  return { n: m.length, avgPct: r1(mean), sePct: r1(m.length > 1 ? sd / Math.sqrt(m.length) : 0), restAvgPct: r1(rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0) };
}

/** Pure: a rule's next status from its backtest (on creation) and forward record. */
export function nextStatus(rule: AiRule, c: Pick<AiCoachConfig, 'minForward' | 'edgePct'>): { status: AiRule['status']; why: string } {
  if (rule.status === 'retired') return { status: 'retired', why: rule.statusWhy };
  const b = rule.backtest;
  const f = rule.forward;
  const good = (s: RuleStats) => (rule.action === 'avoid' ? s.avgPct <= s.restAvgPct - c.edgePct && s.avgPct + s.sePct < 0 : s.avgPct >= s.restAvgPct + c.edgePct && s.avgPct - s.sePct > 0);
  const wrong = (s: RuleStats) => (rule.action === 'avoid' ? s.avgPct >= s.restAvgPct : s.avgPct <= s.restAvgPct);
  if (rule.status === 'testing' && b && b.n >= 8 && wrong(b) && (!f || f.n < c.minForward)) return { status: 'retired', why: `past trades disagree (${b.n} matching averaged ${b.avgPct}% vs ${b.restAvgPct}%)` };
  if (!f || f.n < c.minForward) return { status: rule.status, why: `testing on new trades: ${f?.n ?? 0}/${c.minForward}` };
  if (good(f)) return { status: 'live', why: `proven on ${f.n} new trades: ${f.avgPct}% vs ${f.restAvgPct}% for the rest` };
  if (f.n >= c.minForward * 2 || wrong(f)) return { status: 'retired', why: `didn't hold up on ${f.n} new trades (${f.avgPct}% vs ${f.restAvgPct}%)` };
  return { status: rule.status, why: `not clear yet: ${f.n} new trades, ${f.avgPct}% vs ${f.restAvgPct}%` };
}

// ---------------------------------------------------------------------------
// Live use (evaluator) — cached rules, no I/O
// ---------------------------------------------------------------------------

let liveRules: AiRule[] = [];
let probeCounter = 0;

export function setAiRules(rules: readonly AiRule[]): void {
  liveRules = rules.filter((r) => r.status === 'live');
}

/** What the live AI rules say about a buy: refuse (avoid), easier bar (prefer). */
export function aiRuleVerdict(strategy: string, flat: Readonly<Record<string, number>>, c: Pick<AiCoachConfig, 'probeEvery' | 'preferBarDelta'>): { fail: string | null; barDelta: number; notes: string[] } {
  let barDelta = 0;
  const notes: string[] = [];
  let fail: string | null = null;
  for (const r of liveRules) {
    if (!matchRule(r, strategy, flat)) continue;
    if (r.action === 'prefer') {
      barDelta += c.preferBarDelta;
      notes.push(`AI rule: ${r.title}`);
    } else if (!fail) {
      probeCounter++;
      if (c.probeEvery > 0 && probeCounter % c.probeEvery === 0) notes.push(`AI rule "${r.title}" matched — probe trade (still testing it)`);
      else fail = `AI rule: ${r.title}`;
    }
  }
  return { fail, barDelta: Math.max(-8, barDelta), notes };
}

// ---------------------------------------------------------------------------
// The coach
// ---------------------------------------------------------------------------

/** $ per million tokens (input / output) for the models this coach may use. */
export function priceFor(model: string, promptTokens = 0): { in: number; out: number } {
  if (/haiku-5-5/.test(model)) return promptTokens > 100_000 ? { in: 0.5, out: 2.5 } : { in: 0.1, out: 0.5 };
  if (/sonnet-5/.test(model)) return { in: 2, out: 10 };
  if (/fable/.test(model)) return { in: 10, out: 50 };
  if (/opus-5-5/.test(model)) return { in: 4, out: 20 };
  return { in: 5, out: 25 };
}

const K = { tips: 'ai:tips', rules: 'ai:rules', insights: 'ai:insights', last: 'ai:lastRun', lastDeep: 'ai:lastDeep', reviews: 'ai:reviews', spend: (d: string) => `ai:spend:${d}` };
const STRATS = ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SWING', 'RUNNER'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights', 'rules', 'tipResponses', 'settingChanges'],
  properties: {
    insights: { type: 'array', items: { type: 'string' } },
    tipResponses: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['tipId', 'response'], properties: { tipId: { type: 'string' }, response: { type: 'string' } } },
    },
    settingChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tipId', 'key', 'value', 'why'],
        properties: { tipId: { type: 'string' }, key: { type: 'string', enum: EDITABLE.map((e) => e.key) }, value: { type: 'number' }, why: { type: 'string' } },
      },
    },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'strategy', 'action', 'conditions', 'tipId'],
        properties: {
          tipId: { type: 'string' },
          title: { type: 'string' },
          why: { type: 'string' },
          strategy: { type: 'string', enum: [...STRATS, 'ANY'] },
          action: { type: 'string', enum: ['avoid', 'prefer'] },
          conditions: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['feature', 'op', 'value'], properties: { feature: { type: 'string' }, op: { type: 'string', enum: ['lt', 'gt'] }, value: { type: 'number' } } },
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are the trading coach of an autonomous Solana pump.fun paper-trading bot. It buys memecoins (fresh launches, coins about to graduate, freshly migrated coins, KOL-followed coins, swings on bigger coins) and sells by take-profit tiers, trailing stops and a 10-20% stop loss. Round-trip costs are about 5%.

You get its recent closed trades: the measurable picture at entry (flattened feature names such as market.top10HolderPct or crowd.paperHandsPct), why it bought, how the trade ended, the peak it reached, and the trade coach's lesson. You also get the rules already being tested and how they are doing.

"shape.*" features describe the price action in the 10 minutes BEFORE the buy (run1m/run3m/run10m = % change, offHigh10m = % under the 10-min high, spikes10m/dumps10m = 15-second candles that moved 15%+, greenStreak, wickTopPct = upper wicks = selling into the push, volAccel, buyShare2m). "afterBuy" is what the price did after the buy as multiples of the entry price: min1m (lowest in the first minute), max5m/min5m, peak and secToPeak — e.g. min1m 0.85 with peak 1.0 means it bought the exact top. "whatKeepsGoingWrong" is the bot's own statistical report on its losses. "shadowTrades" are pretend trades on coins it did NOT buy (refused = it wanted to but had no room / a gate said no; near = just under the score bar; skipped = a rule said no) — skippedByRule shows what each filter costs or saves; AI rules are also forward-tested on these. "bestTimesUtc" is market activity (1 = an average hour) and our results per UTC hour / weekday; "entry.hourUtc" / "entry.dowUtc" (0 = Sunday) let a rule target times.

"yourPastReviews" is your own memory: what you said and which rules you added in earlier reviews, with the average result of the trades before and AFTER each review. Learn from it — if results did not improve after an idea, say so and try a different angle instead of repeating it; if they improved, build on it. "otherLearners" is what the bot's statistical learners know right now: the win-probability model (whether it beats the score, and which features it weighs), rules the statistical search discovered, how the budget is shifted between strategies, the learned entry styles, and the recent change log. Do not re-propose rules that already exist there; use your judgement for patterns statistics can't see (behaviour, sequences, combinations).

"exitsAfterSelling" follows every time-based exit (timer: timeStop = no follow-through, stall = no new high, stale = no movement, maxHold) for 30 minutes after the sell: ranPct = % of those coins that went +25% or more after we sold, medianEndX = where the typical coin ended vs our exit price. The bot's exit tuner already lengthens / shortens those timers on its own from this; mention it when a timer clearly sells too early or too late. Exit timers per strategy are in "editableSettings" when the owner asks for an exit change.
"lossExitsAfter" does the same for every stop-loss and rug exit (kind = which exit): backAbovePct = % of coins that came back above our entry within 30 min (the exit was a false alarm / sold the bottom), diedPct = % that kept collapsing (the exit saved money), overshootPts = how far past the stop losses landed (late exits / bad fills). When most losses are stops and rug exits, use this to say whether the problem is the ENTRY (coins that really died → don't buy them) or the EXIT (coins that came back → exit too twitchy).

Focus hardest on ENTRIES: when in a move does it buy — after a vertical spike, at the top of a green streak, on a pullback, into fading volume — and which entries worked. Also look for trends across trades (time of day, kinds of coins, crowd behaviour) and repeated spike patterns.

Read the trades like an experienced trader: look for BEHAVIOUR patterns that separate the losers from the winners — who was buying and selling, how the launch went, holder structure, crowd quality, timing, chart state — not just one number.

Return:
- insights: up to 6 short, concrete observations in plain English (what keeps going wrong or right, especially about entry timing and price patterns, with the evidence).
- rules: up to 4 NEW candidate rules that would have avoided the losers or found more winners. Every condition must use a feature name that appears in the "features" list, with a threshold inside its observed range. Prefer 1-3 conditions per rule. Use strategy "ANY" only when the pattern holds across strategies. Do not repeat a rule that is already being tested. Every rule will be tested on new trades before it is used, so propose what the evidence supports, and return no rules when nothing is clear. Rules that are not from a tip get tipId "".

"ownerTips" are messages from the bot's OWNER, written as if talking to you. They have priority over everything else: the owner knows this market. For every tip with status "new":
- turn it into action: rules (set tipId to the tip's id — these go live at once, no testing; you may use any feature name from "allFeatureNames") and/or settingChanges (only keys listed in "editableSettings", value inside its min–max; set tipId). Do what the tip asks even when the data is thin — but if the data clearly shows it would lose money, still do it and say so plainly in the response.
- answer it in tipResponses (tipId + 2–4 plain, friendly sentences: what you changed, and what the trades say about it). If a tip can't be turned into a rule or setting, say what you'll watch for instead.
Tips with status "done" are standing instructions: keep following them in your insights and rules, don't redo their changes, and don't answer them again.`;

export class AiCoach {
  private timer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private running = false;
  private client: Anthropic | null = null;
  lastError: string | null = null;
  /** The loss autopsy's latest report (set in index.ts) — "what keeps going wrong" goes to the AI too. */
  autopsySource: (() => Autopsy | null) | null = null;
  /** What the other learners know right now (win model, discovered rules, budget shifts, entry styles, change log) — set in index.ts. */
  brainSource: (() => Promise<unknown>) | null = null;
  /** Shadow trades (src/learner/shadow-trades.ts) — set in index.ts. */
  shadowSource: ((sinceMs: number) => Promise<ShadowResult[]>) | null = null;
  shadowReport: ((sinceMs: number) => Promise<ShadowReport>) | null = null;
  /** What coins did after time-based exits (exit-tuner.ts) — set in index.ts. */
  exitSource: (() => { at: string; verdicts: Array<{ strategy: string; timer: string; n: number; ranPct: number; medianEndX: number; avgMaxAfterX: number; action: string }>; lossExits?: unknown[] } | null) | null = null;
  /** Best hours / days to trade (src/learner/timing.ts) — set in index.ts. */
  timingSource: (() => TimingProfile | null) | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly cfg: () => AiCoachConfig,
  ) {
    if (process.env.ANTHROPIC_API_KEY) this.client = new Anthropic();
  }

  get model(): string {
    // Owner (Oct 14): Sonnet 5.5 for every review — better judgment; the daily budget caps the spend (AI_MODEL in .env overrides).
    return process.env.AI_MODEL?.trim() || 'claude-sonnet-5-5';
  }
  /** Once a day a deeper review (twice the trades, effort high) — same Sonnet by default. */
  get deepModel(): string {
    return process.env.AI_DEEP_MODEL?.trim() || 'claude-sonnet-5-5';
  }
  get budgetUsd(): number {
    const b = Number(process.env.AI_DAILY_BUDGET_USD ?? 0.5);
    return Number.isFinite(b) && b >= 0 ? b : 0.5;
  }

  start(): void {
    // The first deep (stronger, pricier) review comes 24 h after the coach first starts, not at once.
    void this.redis.set(K.lastDeep, new Date().toISOString(), 'NX');
    void this.refreshRules();
    this.statsTimer = setInterval(() => void this.refreshRules(), 10 * 60_000);
    this.statsTimer.unref?.();
    this.timer = setInterval(() => void this.review(), Math.max(15, this.cfg().everyMin) * 60_000);
    this.timer.unref?.();
    setTimeout(() => void this.review(), 3 * 60_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
  }

  async spentToday(): Promise<number> {
    return Number((await this.redis.get(K.spend(new Date().toISOString().slice(0, 10)))) ?? 0);
  }

  async rules(): Promise<AiRule[]> {
    const h = await this.redis.hgetall(K.rules);
    return Object.values(h)
      .flatMap((v) => {
        try {
          return [JSON.parse(v) as AiRule];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async snapshot(): Promise<{ enabled: boolean; hasKey: boolean; model: string; deepModel: string; spentTodayUsd: number; budgetUsd: number; lastRun: unknown; lastError: string | null; insights: Array<{ at: string; text: string }>; rules: AiRule[] }> {
    const [spent, last, ins, rules] = await Promise.all([this.spentToday(), this.redis.get(K.last), this.redis.lrange(K.insights, 0, 29), this.rules()]);
    return {
      enabled: this.cfg().enabled,
      hasKey: !!this.client,
      model: this.model,
      deepModel: this.deepModel,
      spentTodayUsd: Math.round(spent * 1000) / 1000,
      budgetUsd: this.budgetUsd,
      lastRun: last ? JSON.parse(last) : null,
      lastError: this.lastError,
      insights: ins.flatMap((x) => {
        try {
          return [JSON.parse(x) as { at: string; text: string }];
        } catch {
          return [];
        }
      }),
      rules,
    };
  }

  /** Closed paper trades (since the reset, 14 days) with their entry features. */
  private async loadTrades(limit = 400): Promise<Array<CoachTrade & { id: string; entryPriceSol: number; symbol: string; exitReason: string; peakMultiple: number; heldMin: number; explanation: string; lesson: string | null; closedAtMs: number }>> {
    const since = new Date(Math.max((await learningSince(this.redis))?.getTime() ?? 0, Date.now() - 14 * 86_400_000));
    const rows = await prisma.position.findMany({
      where: { mode: 'PAPER', status: 'CLOSED', closedAt: { gte: since } },
      orderBy: { closedAt: 'desc' },
      take: limit,
      select: { id: true, strategy: true, sizeSol: true, realizedPnlSol: true, exitReason: true, entryPriceSol: true, peakPriceSol: true, openedAt: true, closedAt: true, entryContext: true, token: { select: { symbol: true, createdAt: true } }, evaluation: { select: { combinedScore: true, features: true } } },
    });
    return rows.map((p) => {
      const ec = (p.entryContext ?? {}) as { marketCapUsd?: number; kols?: number; explanation?: string; review?: { lesson?: string } };
      return {
        id: p.id,
        entryPriceSol: p.entryPriceSol,
        strategy: p.strategy,
        symbol: p.token?.symbol ?? '?',
        pnlPct: p.sizeSol > 0 ? (p.realizedPnlSol / p.sizeSol) * 100 : 0,
        openedAtMs: p.openedAt.getTime(),
        closedAtMs: p.closedAt?.getTime() ?? 0,
        exitReason: p.exitReason ?? 'UNKNOWN',
        peakMultiple: p.entryPriceSol > 0 ? Math.round((p.peakPriceSol / p.entryPriceSol) * 100) / 100 : 1,
        heldMin: p.closedAt ? Math.round((p.closedAt.getTime() - p.openedAt.getTime()) / 6_000) / 10 : 0,
        explanation: (ec.explanation ?? '').slice(0, 250),
        lesson: ec.review?.lesson ?? null,
        flat: flattenFeatures(p.evaluation?.features, {
          score: p.evaluation?.combinedScore ?? null,
          kols: ec.kols ?? null,
          mcUsd: ec.marketCapUsd ?? null,
          ageMin: p.token ? (p.openedAt.getTime() - p.token.createdAt.getTime()) / 60_000 : null,
          hourUtc: p.openedAt.getUTCHours(),
          dowUtc: p.openedAt.getUTCDay(),
        }),
      };
    });
  }

  async tips(): Promise<OwnerTip[]> {
    return (await this.redis.lrange(K.tips, 0, TIP_MAX - 1)).flatMap((x) => {
      try {
        return [JSON.parse(x) as OwnerTip];
      } catch {
        return [];
      }
    });
  }

  private async saveTips(tips: OwnerTip[]): Promise<void> {
    const p = this.redis.multi().del(K.tips);
    if (tips.length) p.rpush(K.tips, ...tips.slice(0, TIP_MAX).map((t) => JSON.stringify(t)));
    await p.exec();
  }

  /** The owner talks to the brain: store the tip and run a (cheap) review at once so it gets acted on. */
  async addTip(text: string): Promise<{ tip: OwnerTip; review: Promise<{ ran: boolean; why: string }> }> {
    const tip: OwnerTip = { id: `t${Date.now().toString(36)}`, at: new Date().toISOString(), text: text.trim().slice(0, 1000), status: 'new', response: null, rules: [], settings: [], answeredAt: null };
    await this.redis.multi().lpush(K.tips, JSON.stringify(tip)).ltrim(K.tips, 0, TIP_MAX - 1).exec();
    void recordChange({ source: 'owner-tip', strategy: null, what: `You told the brain: "${tip.text.slice(0, 140)}"`, why: 'the AI coach works it in now' });
    return { tip, review: this.reviewTips() };
  }

  /** Remove a tip; the rules made from it are switched off. */
  async removeTip(id: string): Promise<boolean> {
    const tips = await this.tips();
    if (!tips.some((t) => t.id === id)) return false;
    await this.saveTips(tips.filter((t) => t.id !== id));
    const rules = await this.rules();
    const p = this.redis.pipeline();
    for (const r of rules.filter((x) => x.tipId === id && x.status !== 'retired')) {
      r.status = 'retired';
      r.statusWhy = 'you removed the tip';
      p.hset(K.rules, r.id, JSON.stringify(r));
    }
    await p.exec();
    await this.refreshRules();
    return true;
  }

  private tipRetry: NodeJS.Timeout | null = null;
  /** Review now for the owner's tips; if a review is already running, try again shortly. */
  private async reviewTips(): Promise<{ ran: boolean; why: string }> {
    const r = await this.review(true, false, true);
    if (!r.ran && r.why === 'already running' && !this.tipRetry) {
      this.tipRetry = setTimeout(() => {
        this.tipRetry = null;
        void this.reviewTips();
      }, 60_000);
      this.tipRetry.unref?.();
    }
    return r;
  }

  /**
   * Rules found by the statistical rule search (policy-search.ts) join the same pipeline as the AI's: they start as
   * 'testing' and only go live after they hold up on NEW trades. Near-duplicates of existing rules are skipped.
   */
  async addDiscoveredRules(
    cands: ReadonlyArray<{ title: string; why: string; strategy: string | null; action: 'avoid' | 'prefer'; conditions: AiRuleCondition[]; evidence: { n: number; avgPct: number; restAvgPct: number } }>,
    maxSearchRules = 6,
  ): Promise<number> {
    const rules = await this.rules();
    const open = rules.filter((r) => r.status !== 'retired');
    const searchOpen = open.filter((r) => r.source === 'search').length;
    const same = (a: AiRuleCondition[], b: AiRuleCondition[]) =>
      a.length === b.length && a.every((x) => b.some((y) => y.feature === x.feature && y.op === x.op && Math.abs(y.value - x.value) <= Math.abs(x.value) * 0.15 + 1e-9));
    const at = new Date().toISOString();
    let added = 0;
    const known: AiRule[] = [...rules];
    const p = this.redis.pipeline();
    for (const c of cands) {
      if (searchOpen + added >= maxSearchRules) break;
      // Also skip rules that were tried and retired recently (don't re-test the same idea forever).
      if (known.some((r) => (r.strategy ?? null) === (c.strategy ?? null) && r.action === c.action && same(r.conditions, c.conditions))) continue;
      const rule: AiRule = {
        id: `s${Date.now().toString(36)}${added}`,
        title: c.title.slice(0, 120),
        why: c.why.slice(0, 400),
        strategy: c.strategy,
        action: c.action,
        conditions: c.conditions.slice(0, 4),
        createdAt: at,
        status: 'testing',
        statusWhy: 'found in past trades — now testing on new trades',
        backtest: { n: c.evidence.n, avgPct: c.evidence.avgPct, sePct: 0, restAvgPct: c.evidence.restAvgPct },
        forward: null,
        source: 'search',
      };
      known.push(rule);
      p.hset(K.rules, rule.id, JSON.stringify(rule));
      added++;
    }
    if (added) await p.exec();
    return added;
  }

  /** Re-score every rule on the latest trades (no AI call). */
  async refreshRules(): Promise<void> {
    try {
      const rules = await this.rules();
      if (!rules.length) return setAiRules([]);
      const trades: CoachTrade[] = await this.loadTrades();
      // Shadow trades: coins it would have bought (refused / just under the bar) + coins an AI rule kept it out
      // of — what those did is exactly the forward evidence a rule needs (faster than waiting for real trades).
      const since = (await learningSince(this.redis))?.getTime() ?? 0;
      const sh = this.shadowSource ? await this.shadowSource(Math.max(since, Date.now() - 14 * 86_400_000)).catch(() => []) : [];
      for (const x of sh) if (wouldHaveTaken(x) || x.why.startsWith('AI rule')) trades.push({ strategy: x.strategy, pnlPct: x.pnlPct, openedAtMs: x.openedAtMs, flat: x.flat });
      const c = this.cfg();
      const p = this.redis.pipeline();
      for (const r of rules) {
        if (r.status === 'retired') continue;
        const created = Date.parse(r.createdAt);
        r.forward = ruleStats(r, trades.filter((t) => t.openedAtMs > created));
        // The owner's tip: live until the owner removes it (the results are still tracked and shown).
        const next = r.source === 'owner' ? { status: 'live' as const, why: `your tip — live${r.forward?.n ? ` (${r.forward.n} trades since: ${r.forward.avgPct}% vs ${r.forward.restAvgPct}% for the rest)` : ''}` } : nextStatus(r, c);
        if (next.status !== r.status) {
          log.info({ rule: r.title, from: r.status, to: next.status, why: next.why }, '🤖 AI rule status changed');
          if (next.status === 'live' || r.status === 'live')
            void recordChange({ source: 'ai-coach', strategy: r.strategy, what: next.status === 'live' ? `AI rule switched ON: ${r.action === 'avoid' ? 'avoid' : 'prefer'} "${r.title}"` : `AI rule switched off: "${r.title}"`, why: next.why });
        }
        r.status = next.status;
        r.statusWhy = next.why;
        p.hset(K.rules, r.id, JSON.stringify(r));
      }
      await p.exec();
      setAiRules(rules);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'AI rule refresh failed');
    }
  }

  /**
   * Ask Claude to review the latest trades (when there are new ones and budget left). `ownerAsked` = the owner pressed
   * Run (or a deep review) on the dashboard; tips and owner runs go through even over the daily budget (owner, Oct 15:
   * "allow the brain commands to go regardless, even if it's over the daily budget") — only the automatic reviews stop.
   */
  async review(force = false, deepAsked = false, forTips = false, ownerAsked = false): Promise<{ ran: boolean; why: string }> {
    const c = this.cfg();
    if (!c.enabled) return { ran: false, why: 'AI coach is off' };
    if (!this.client) return { ran: false, why: 'no ANTHROPIC_API_KEY on the server' };
    if (this.running) return { ran: false, why: 'already running' };
    this.running = true;
    try {
      const spent = await this.spentToday();
      const tips = await this.tips();
      const newTips = tips.filter((t) => t.status === 'new');
      const overBudget = spent >= this.budgetUsd;
      // Over budget: automatic reviews stop, but the owner's tips / Run button still go (a pending tip turns an automatic
      // review into a cheap tip review).
      if (overBudget && !ownerAsked && !forTips) {
        if (!newTips.length) return { ran: false, why: `daily AI budget used ($${spent.toFixed(2)} of $${this.budgetUsd})` };
        forTips = true;
      }
      if (overBudget) log.info({ spent, budget: this.budgetUsd }, 'AI review over the daily budget — your tip / run request goes through anyway');
      const trades = await this.loadTrades();
      if (forTips && !newTips.length) return { ran: false, why: 'no new tips' };
      const last = JSON.parse((await this.redis.get(K.last)) ?? 'null') as { at: string; newestClosedMs: number } | null;
      const newest = trades[0]?.closedAtMs ?? 0;
      const fresh = trades.filter((t) => t.closedAtMs > (last?.newestClosedMs ?? 0)).length;
      if (!force && !newTips.length && fresh < c.minNewTrades) return { ran: false, why: `only ${fresh} new closed trades (needs ${c.minNewTrades})` };
      if (trades.length < 10 && !newTips.length) return { ran: false, why: `only ${trades.length} closed trades so far` };
      // Deep review: once every 24 h (or when asked) — stronger model, twice the trades, more effort.
      const lastDeepAt = Date.parse((await this.redis.get(K.lastDeep)) ?? '') || 0;
      const deep = !forTips && !!this.deepModel && this.deepModel !== 'off' && (deepAsked || (Date.now() - lastDeepAt >= 24 * 3600_000 && spent < this.budgetUsd * 0.4));
      const model = deep ? this.deepModel : this.model;

      const rules = await this.rules();
      const sample = trades.slice(0, deep ? c.tradesPerReview * 2 : c.tradesPerReview);
      // Features worth showing: present on most trades and actually varying.
      const names = new Map<string, number[]>();
      for (const t of sample) for (const [k, v] of Object.entries(t.flat)) names.set(k, [...(names.get(k) ?? []), v]);
      const featureList = [...names.entries()]
        .filter(([, vs]) => vs.length >= sample.length * 0.3 && Math.min(...vs) !== Math.max(...vs))
        .map(([k, vs]) => {
          const s = [...vs].sort((a, b) => a - b);
          return { name: k, min: r1(s[0]!), median: r1(s[Math.floor(s.length / 2)]!), max: r1(s[s.length - 1]!) };
        })
        .slice(0, 50);
      const allowed = new Set(featureList.map((f) => f.name));
      // What the price did right after each buy (from the position's price history).
      const after = await Promise.all(sample.map(async (t) => afterEntry(await readHistory(t.id).catch(() => []), t.entryPriceSol, t.openedAtMs)));
      const au = this.autopsySource?.() ?? null;
      const tm = this.timingSource?.() ?? null;
      const shr = this.shadowReport ? await this.shadowReport((await learningSince(this.redis))?.getTime() ?? 0).catch(() => null) : null;
      // Memory: its own past reviews and what happened to the results AFTER each one (did its advice help?).
      const past = (await this.redis.lrange(K.reviews, 0, 5)).flatMap((x) => {
        try {
          return [JSON.parse(x) as { at: string; insights: string[]; rulesAdded: string[]; before: { n: number; avgPct: number } }];
        } catch {
          return [];
        }
      });
      const realAfter = (atIso: string) => {
        const t0 = Date.parse(atIso);
        const xs = trades.filter((t) => t.openedAtMs > t0).map((t) => t.pnlPct);
        return { n: xs.length, avgPct: xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null };
      };
      const brain = this.brainSource ? await this.brainSource().catch(() => null) : null;
      const recent30 = trades.slice(0, 30).map((t) => t.pnlPct);
      const allNames = new Set(trades.flatMap((t) => Object.keys(t.flat)));
      const cfgNow = getConfig();
      const input = {
        ownerTips: tips.slice(0, 15).map((t) => ({ id: t.id, at: t.at, text: t.text, status: t.status, whatYouDid: t.response })),
        editableSettings: newTips.length ? EDITABLE.map((e) => ({ key: e.key, group: e.group, label: e.label, min: e.min, max: e.max, unit: e.unit ?? null, now: getPath(cfgNow, e.key) })) : undefined,
        allFeatureNames: newTips.length ? [...allNames].slice(0, 400) : undefined,
        yourPastReviews: past.map((r) => ({ at: r.at, insights: r.insights, rulesYouAdded: r.rulesAdded, resultsBefore: r.before, resultsAfter: realAfter(r.at) })),
        otherLearners: brain,
        exitsAfterSelling: this.exitSource?.()?.verdicts.slice(0, 12) ?? null,
        lossExitsAfter: this.exitSource?.()?.lossExits?.slice(0, 12) ?? null,
        shadowTrades: shr && shr.total
          ? {
              note: 'pretend trades on coins the bot did NOT buy, followed with its own exits',
              byKind: shr.byKind,
              skippedByRule: shr.byRule.slice(0, 10).map((g) => ({ rule: g.key, n: g.n, avgPct: g.avgPct, went2xPct: g.went2xPct })),
              refusedBecause: shr.byRefusal.slice(0, 6).map((g) => ({ why: g.key, n: g.n, avgPct: g.avgPct })),
              findings: shr.findings,
            }
          : null,
        bestTimesUtc: tm
          ? {
              busiestHours: tm.busiestHours,
              bestHours: tm.bestHours,
              worstHours: tm.worstHours,
              bestDays: tm.bestDays.map((d) => DAY_NAMES[d]),
              byHour: tm.hours.map((h, i) => ({ hour: i, activity: h.activity, trades: h.trades, avgPct: h.avgPct })).filter((h) => h.trades > 0 || h.activity !== null),
            }
          : null,
        whatKeepsGoingWrong: au
          ? { findings: au.findings, losers: au.losers, overall: { winRatePct: au.overall.winRatePct, neededWinRatePct: au.overall.neededWinRatePct, avgWinPct: au.overall.avgWinPct, avgLossPct: au.overall.avgLossPct }, worstKinds: au.worst.slice(0, 6).map((w) => ({ strategy: w.strategy, kind: w.band, n: w.n, avgPct: w.avgPct, pnlSol: w.pnlSol })), bestKinds: au.best.slice(0, 4).map((w) => ({ strategy: w.strategy, kind: w.band, n: w.n, avgPct: w.avgPct })) }
          : null,
        features: featureList,
        trades: sample.map((t, i) => ({
          strategy: t.strategy,
          symbol: t.symbol,
          resultPct: r1(t.pnlPct),
          exit: t.exitReason,
          peakMultiple: t.peakMultiple,
          heldMin: t.heldMin,
          whyBought: t.explanation,
          coachLesson: t.lesson,
          afterBuy: after[i],
          atEntry: Object.fromEntries(Object.entries(t.flat).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, r1(v)])),
        })),
        rulesBeingTested: rules.filter((r) => r.status !== 'retired').map((r) => ({ title: r.title, strategy: r.strategy ?? 'ANY', action: r.action, conditions: r.conditions, status: r.status, result: r.forward ?? r.backtest })),
        retiredRules: rules.filter((r) => r.status === 'retired').slice(0, 10).map((r) => ({ title: r.title, why: r.statusWhy })),
      };

      // Server-side refusal fallback exists for the Opus / Sonnet / Fable models, not for Haiku.
      const fallback = /haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const };
      const res = await this.client.beta.messages.create({
        model,
        max_tokens: 16000,
        ...fallback,
        system: SYSTEM,
        output_config: { effort: deep ? 'high' : 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content: `Here are the bot's ${sample.length} most recent closed trades (newest first) as JSON:\n\n${JSON.stringify(input)}` }],
      });
      // Cost from the real usage at the model's price (AI_PRICE_IN/OUT_PER_MTOK override).
      const promptTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      const price = priceFor(model, promptTokens);
      const inP = Number(process.env.AI_PRICE_IN_PER_MTOK ?? price.in);
      const outP = Number(process.env.AI_PRICE_OUT_PER_MTOK ?? price.out);
      const cost = ((res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) * 0.1 + (res.usage.cache_creation_input_tokens ?? 0) * 1.25) * inP + res.usage.output_tokens * outP) / 1e6;
      const day = new Date().toISOString().slice(0, 10);
      await this.redis.multi().incrbyfloat(K.spend(day), cost).expire(K.spend(day), 3 * 86_400).exec();
      await this.redis.set(K.last, JSON.stringify({ at: new Date().toISOString(), newestClosedMs: newest, trades: sample.length, costUsd: Math.round(cost * 1000) / 1000, model, deep }));
      if (deep) await this.redis.set(K.lastDeep, new Date().toISOString());

      if (res.stop_reason === 'refusal') {
        this.lastError = 'the AI declined this review';
        return { ran: true, why: this.lastError };
      }
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const out = JSON.parse(text) as {
        insights: string[];
        rules: Array<{ tipId?: string; title: string; why: string; strategy: string; action: 'avoid' | 'prefer'; conditions: AiRuleCondition[] }>;
        tipResponses?: Array<{ tipId: string; response: string }>;
        settingChanges?: Array<{ tipId: string; key: string; value: number; why: string }>;
      };
      const tipIds = new Set(newTips.map((t) => t.id));
      const at = new Date().toISOString();
      const p = this.redis.pipeline();
      for (const i of out.insights.slice(0, 6).reverse()) p.lpush(K.insights, JSON.stringify({ at, text: i.slice(0, 400) }));
      p.ltrim(K.insights, 0, 59);
      let added = 0;
      const active = rules.filter((r) => r.status !== 'retired').length;
      const tipRules = new Map<string, string[]>();
      for (const r of out.rules.slice(0, 4 + newTips.length * 2)) {
        const fromTip = !!r.tipId && tipIds.has(r.tipId);
        const known = fromTip ? allNames : allowed;
        const conditions = r.conditions.filter((x) => known.has(x.feature) && Number.isFinite(x.value)).slice(0, 4);
        if (!conditions.length || conditions.length !== r.conditions.length) continue; // invented a feature → drop
        if (!fromTip && active + added >= c.maxRules) continue;
        const rule: AiRule = {
          id: `r${Date.now().toString(36)}${added}`,
          title: r.title.slice(0, 120),
          why: r.why.slice(0, 400),
          strategy: r.strategy === 'ANY' ? null : r.strategy,
          action: r.action,
          conditions,
          createdAt: at,
          status: 'testing',
          statusWhy: 'new — testing on new trades',
          backtest: null,
          forward: null,
          ...(fromTip ? { source: 'owner' as const, tipId: r.tipId } : {}),
        };
        rule.backtest = ruleStats(rule, trades);
        const s = fromTip ? { status: 'live' as const, why: 'your tip — live now (results still tracked)' } : nextStatus(rule, c);
        rule.status = s.status;
        rule.statusWhy = s.why;
        p.hset(K.rules, rule.id, JSON.stringify(rule));
        if (fromTip) tipRules.set(r.tipId!, [...(tipRules.get(r.tipId!) ?? []), `${rule.action} ${rule.strategy ?? 'any strategy'}: ${rule.title}`]);
        added++;
      }
      p.lpush(K.reviews, JSON.stringify({ at, model, insights: out.insights.slice(0, 3).map((x) => x.slice(0, 200)), rulesAdded: out.rules.slice(0, 4).map((r) => r.title.slice(0, 120)), before: { n: recent30.length, avgPct: recent30.length ? r1(recent30.reduce((a, b) => a + b, 0) / recent30.length) : 0 } }));
      p.ltrim(K.reviews, 0, 19);
      await p.exec();
      // The owner's tips: apply the setting changes the AI made for them and store its answer.
      if (newTips.length) {
        const tipSettings = new Map<string, string[]>();
        for (const ch of (out.settingChanges ?? []).filter((x) => tipIds.has(x.tipId)).slice(0, 12)) {
          const tip = newTips.find((t) => t.id === ch.tipId)!;
          const res = await applyEdit(ch.key, ch.value, 'owner-tip', `your tip "${tip.text.slice(0, 80)}" — ${ch.why.slice(0, 160)}`);
          tipSettings.set(ch.tipId, [...(tipSettings.get(ch.tipId) ?? []), res.ok ? res.text : `not changed (${res.error})`]);
        }
        const answers = new Map((out.tipResponses ?? []).map((x) => [x.tipId, x.response.slice(0, 800)]));
        const latest = await this.tips();
        for (const t of latest) {
          if (!tipIds.has(t.id)) continue;
          t.status = 'done';
          t.answeredAt = at;
          t.response = answers.get(t.id) ?? 'Noted — I will keep this in mind in every review.';
          t.rules = tipRules.get(t.id) ?? [];
          t.settings = tipSettings.get(t.id) ?? [];
        }
        await this.saveTips(latest);
        await this.refreshRules();
      }
      // Keep the store small: drop the oldest retired rules beyond 40.
      const all = await this.rules();
      const retired = all.filter((r) => r.status === 'retired');
      if (retired.length > 40) await this.redis.hdel(K.rules, ...retired.slice(40).map((r) => r.id));
      this.lastError = null;
      log.info({ insights: out.insights.length, rules: added, costUsd: cost.toFixed(3) }, '🤖 AI coach reviewed the latest trades');
      return { ran: true, why: `${deep ? 'deep review: ' : ''}read ${sample.length} trades, ${out.insights.length} insights, ${added} new rules to test ($${cost.toFixed(3)})` };
    } catch (err) {
      this.lastError = err instanceof Anthropic.AuthenticationError ? 'the ANTHROPIC_API_KEY was rejected' : err instanceof Anthropic.RateLimitError ? 'rate limited by the AI API — will retry next hour' : (err as Error).message.slice(0, 200);
      log.warn({ err: this.lastError }, 'AI coach review failed');
      return { ran: false, why: this.lastError };
    } finally {
      this.running = false;
    }
  }
}
