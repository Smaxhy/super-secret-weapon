/**
 * Policy tournament (v11.15) — instead of ONE Sniper setting, ~20 entry + exit variants trade VIRTUALLY on the same live
 * candidates at the same time (VirtualBook: the bot's own decideExit, same prices, same paper costs; nothing is bought).
 *
 * Candidates: every coin the evaluator scores whose rules all pass, or that fails ONLY the momentum gate (the one rule a
 * variant can change), with no hard safety fail, in a switched-on strategy. For each variant the pure Sniper entry check
 * is re-run with that variant's overrides; a variant that would buy opens a virtual trade with its exit overrides
 * (Sniper exit overlay rebuilt from the variant's `sniper.exits.*`, then `exit.*` keys) — once per coin per variant per
 * 30 min. `random` buys 1 in `randomEvery` scored coins (no hard safety fail) at random: the yardstick.
 *
 * Note: virtual trades buy at the signal price — the live dip wait and the confirmation wait are not simulated.
 *
 * Winners: Benjamini–Hochberg (q) across the variants on a one-sided Welch test vs the baseline, AND avg ≥ baseline avg
 * + `beatLiveByPts`, AND still positive without its 3 best trades, AND n ≥ `minResults`. The baseline is `live` when it
 * has enough results; when live hardly trades (its strict rules are the problem) the random yardstick; else zero.
 * A winner is never applied here — its single editable key is OFFERED to the self-improving loop, which still has to
 * prove it on the recorded market (replay) and pass its validation before anything changes.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG, type BotConfigShape } from '../config/default';
import { EDITABLE } from '../config/editable';
import { deepMerge, getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import { momentumGateFails, type MomentumGateConfig, type ShapeInput } from '../evaluator/momentum-gate';
import { sniperEntryFails, sniperExitOverlay, type SniperConfig, type SniperEntryInput, type SniperExits } from '../evaluator/sniper';
import { moduleLogger } from '../lib/logger';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { bhQValues, groupStats, twoSidedP, welch, type Sums } from './policy-search';
import { labStats, type LabStats } from './strategy-lab';
import { VirtualBook, type VirtualResult } from './virtual-book';

const log = moduleLogger('tournament');
type ExitRules = BotConfigShape['exit'];

export interface TournamentVariant {
  id: string;
  name: string;
  /** Dotted config paths (sniper.*, momentumGate.*) → value, layered over the live entry settings. */
  entryOverrides: Record<string, unknown>;
  /** Dotted config paths (sniper.exits.*, exit.*) → value, layered over the live exit settings. */
  exitOverrides: Record<string, unknown>;
  /** The random yardstick: buys 1 in `randomEvery` scored coins, ignores the entry rules. */
  random?: boolean;
}

export interface TournamentConfig {
  enabled: boolean;
  maxOpen: number;
  minResults: number;
  q: number;
  beatLiveByPts: number;
  cooldownMin: number;
  randomEvery: number;
  keepResults: number;
  onlyEnabledStrategies: boolean;
  variants: readonly TournamentVariant[];
}

export const LIVE_ID = 'live';
export const RANDOM_ID = 'random';
const resKey = (id: string) => `tour:res:${id}`;
const STATS_KEY = 'tour:stats';
const OFFERS_KEY = 'tour:offers';

/** What the evaluator hands over for one scored coin (everything already computed — no new DB / RPC). */
export interface TournamentCandidate {
  mint: string;
  symbol: string;
  strategy: StrategyName;
  strategyEnabled: boolean;
  priceSol: number;
  onAmm: boolean;
  hardFail: boolean;
  ruleFails: readonly string[];
  shape: ShapeInput | null;
  /** Sniper entry inputs as the live evaluator saw them (score, threshold, flow, gates, crowd …). */
  sniper: Omit<SniperEntryInput, 'explore' | 'probe' | 'dipEntry'>;
  /** v11.16 AI meme score (0–10) when the meme reader has one for this coin. */
  memeScore?: number | null;
}

export interface TournamentResult {
  variant: string;
  mint: string;
  symbol: string;
  strategy: StrategyName;
  pnlPct: number;
  peakX: number;
  holdSec: number;
  reason: string;
  at: number;
}

export interface VariantStats extends LabStats {
  /** Σ P&L at 1 SOL per trade. */
  totalSol: number;
  /** Average of the newest 30% of results. */
  newestAvgPct: number;
}

export type VariantStatus = 'winner' | 'leading' | 'losing' | 'too few' | 'baseline';

export interface VariantRow extends VariantStats {
  vsBaselinePts: number | null;
  q: number | null;
  status: VariantStatus;
  keys: string[];
}

export interface Offer {
  variant: string;
  key: string;
  value: unknown;
  at: number;
  result: string;
}

// ───────────────────────────── pure helpers ─────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Pure: `{ 'a.b': 1, 'a.c': 2 }` with prefix 'a.' → `{ b: 1, c: 2 }` nested. Keys without the prefix are ignored. */
export function nestPrefixed(over: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(over)) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split('.');
    let node = out;
    for (const k of parts.slice(0, -1)) {
      if (!isObj(node[k])) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = value;
  }
  return out;
}

/** Pure: the variant's Sniper entry config (always enabled — the tournament compares Sniper settings). */
export function variantSniper(base: SniperConfig, v: Pick<TournamentVariant, 'entryOverrides'>): SniperConfig {
  const merged = deepMerge(base, nestPrefixed(v.entryOverrides, 'sniper.')) as SniperConfig;
  return { ...merged, enabled: true };
}

/** Pure: the variant's momentum gate config. */
export function variantMomentum(base: MomentumGateConfig, v: Pick<TournamentVariant, 'entryOverrides'>): MomentumGateConfig {
  return deepMerge(base, nestPrefixed(v.entryOverrides, 'momentumGate.')) as MomentumGateConfig;
}

/** Pure: is this scored coin a candidate (no hard fail; only momentum-gate rule fails at most)? */
export function isCandidate(c: Pick<TournamentCandidate, 'hardFail' | 'ruleFails'>): boolean {
  return !c.hardFail && c.ruleFails.every((f) => f.startsWith('momentum gate: ') || f.startsWith('meme score '));
}

/** Pure: would this variant buy the candidate? (empty fails = buy) */
export function variantEntryFails(c: TournamentCandidate, v: TournamentVariant, liveSniper: SniperConfig, liveMg: MomentumGateConfig): string[] {
  const mgKeys = Object.keys(v.entryOverrides).some((k) => k.startsWith('momentumGate.'));
  const mgWhy = mgKeys ? momentumGateFails(c.shape, variantMomentum(liveMg, v)) : c.sniper.momentumGateWhy;
  // Meme score gate (v11.16): a variant with its own `meme.minScore` judges the coin's meme score itself (no read = no
  // verdict, like live); otherwise the live gate's verdict stands.
  const memeMin = v.entryOverrides['meme.minScore'];
  const memeFails = typeof memeMin === 'number'
    ? (memeMin > 0 && typeof c.memeScore === 'number' && c.memeScore < memeMin ? [`meme score ${c.memeScore} < ${memeMin}`] : [])
    : c.ruleFails.filter((f) => f.startsWith('meme score '));
  return [...memeFails, ...sniperEntryFails({ ...c.sniper, momentumGateWhy: mgWhy, explore: false, probe: false, dipEntry: false }, variantSniper(liveSniper, v))];
}

/** Pure: the variant's exit rules — live rules, the Sniper overlay rebuilt with the variant's exits, then `exit.*` keys. */
export function variantExitRules(live: ExitRules, v: Pick<TournamentVariant, 'exitOverrides'>, liveSniperExits: SniperExits): ExitRules {
  const sn = deepMerge(liveSniperExits, nestPrefixed(v.exitOverrides, 'sniper.exits.')) as SniperExits;
  const withSniper = deepMerge(live, sniperExitOverlay(sn, live.stopLoss?.minPct ?? 12)) as ExitRules;
  const exitOver = nestPrefixed(v.exitOverrides, 'exit.');
  return Object.keys(exitOver).length ? (deepMerge(withSniper, exitOver) as ExitRules) : withSniper;
}

/** Pure: stats for one variant (lab stats + Σ SOL at 1 SOL + newest-30% average). Rows newest first. */
export function variantStats(id: string, name: string, rows: readonly Pick<TournamentResult, 'pnlPct'>[]): VariantStats {
  const base = labStats(id, name, rows);
  const xs = rows.map((r) => r.pnlPct).filter((x) => Number.isFinite(x));
  const newest = xs.slice(0, Math.max(1, Math.ceil(xs.length * 0.3)));
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    ...base,
    totalSol: Math.round((xs.reduce((a, b) => a + b, 0) / 100) * 1000) / 1000,
    newestAvgPct: xs.length ? r1(newest.reduce((a, b) => a + b, 0) / newest.length) : 0,
  };
}

const sums = (xs: readonly number[]): Sums => xs.reduce<Sums>((s, y) => ({ w: s.w + 1, w2: s.w2 + 1, wy: s.wy + y, wy2: s.wy2 + y * y }), { w: 0, w2: 0, wy: 0, wy2: 0 });

/** Pure: one-sided p that `a` has a higher mean than `b` (Welch), or than 0 when `b` is null. */
export function oneSidedP(a: readonly number[], b: readonly number[] | null): number {
  const ga = groupStats(sums(a));
  if (b) {
    const w = welch(ga, groupStats(sums(b)));
    return w.t > 0 ? w.p / 2 : 1 - w.p / 2;
  }
  if (ga.neff <= 1) return 1;
  if (!(ga.se > 0) || !Number.isFinite(ga.se)) return ga.mean > 0 ? 0 : 1;
  const t = ga.mean / ga.se;
  const p = twoSidedP(t, ga.neff - 1);
  return t > 0 ? p / 2 : 1 - p / 2;
}

/**
 * Pure: rank the variants. `rows` = % P&L per variant, newest first. Baseline = live when it has ≥ half of minResults
 * (and ≥10) results, else the random yardstick under the same rule, else zero.
 */
export function judge(
  variants: readonly Pick<TournamentVariant, 'id' | 'name' | 'random' | 'entryOverrides' | 'exitOverrides'>[],
  rows: ReadonlyMap<string, readonly number[]>,
  c: Pick<TournamentConfig, 'minResults' | 'q' | 'beatLiveByPts'>,
): { rows: VariantRow[]; baseline: string } {
  const need = Math.max(10, Math.ceil(c.minResults / 2));
  const live = rows.get(LIVE_ID) ?? [];
  const rnd = rows.get(RANDOM_ID) ?? [];
  const baseline = live.length >= need ? LIVE_ID : rnd.length >= need ? RANDOM_ID : 'zero';
  const baseRows = baseline === LIVE_ID ? live : baseline === RANDOM_ID ? rnd : null;
  const baseAvg = baseRows && baseRows.length ? baseRows.reduce((a, b) => a + b, 0) / baseRows.length : 0;
  const stats = variants.map((v) => variantStats(v.id, v.name, (rows.get(v.id) ?? []).map((pnlPct) => ({ pnlPct }))));
  const tested = variants.map((v, i) => ({ v, s: stats[i]! })).filter(({ v, s }) => v.id !== baseline && !v.random && v.id !== LIVE_ID && s.n >= c.minResults);
  const ps = tested.map(({ v }) => oneSidedP(rows.get(v.id) ?? [], baseRows));
  const qs = bhQValues(ps);
  const qOf = new Map(tested.map(({ v }, i) => [v.id, qs[i]!]));
  const out: VariantRow[] = variants.map((v, i) => {
    const s = stats[i]!;
    const keys = [...Object.keys(v.entryOverrides), ...Object.keys(v.exitOverrides)];
    const vs = Math.round((s.avgPnlPct - baseAvg) * 10) / 10;
    if (v.id === baseline) return { ...s, vsBaselinePts: null, q: null, status: 'baseline', keys };
    if (v.random || v.id === LIVE_ID) return { ...s, vsBaselinePts: vs, q: null, status: s.n < c.minResults ? 'too few' : s.avgPnlPct >= baseAvg ? 'leading' : 'losing', keys };
    if (s.n < c.minResults) return { ...s, vsBaselinePts: vs, q: null, status: 'too few', keys };
    const q = qOf.get(v.id) ?? 1;
    const winner = q <= c.q && s.avgPnlPct >= baseAvg + c.beatLiveByPts && s.trimmedAvgPct > 0;
    const status: VariantStatus = winner ? 'winner' : s.avgPnlPct > baseAvg && s.avgPnlPct > 0 ? 'leading' : 'losing';
    return { ...s, vsBaselinePts: vs, q: Math.round(q * 1000) / 1000, status, keys };
  });
  return { rows: out, baseline };
}

const editableKey = (k: string): boolean => EDITABLE.some((e) => e.key === k);

/**
 * Pure: what to offer the self-improving loop for each winner. A single-key variant offers that key; a multi-key
 * variant offers only a key whose own single-key variant also won (the best one); everything else is skipped.
 */
export function offersFor(variants: readonly TournamentVariant[], judged: readonly VariantRow[]): Array<{ variant: string; key: string; value: unknown } | { variant: string; skip: string }> {
  const byId = new Map(variants.map((v) => [v.id, v]));
  const winners = judged.filter((r) => r.status === 'winner');
  const singleWinners = winners.filter((r) => r.keys.length === 1);
  const out: Array<{ variant: string; key: string; value: unknown } | { variant: string; skip: string }> = [];
  for (const w of winners) {
    const v = byId.get(w.id);
    if (!v) continue;
    const over = { ...v.entryOverrides, ...v.exitOverrides };
    let key: string | null = null;
    if (w.keys.length === 1) key = w.keys[0]!;
    else {
      const best = singleWinners.filter((s) => w.keys.includes(s.keys[0]!)).sort((a, b) => b.avgPnlPct - a.avgPnlPct)[0];
      key = best ? best.keys[0]! : null;
    }
    if (!key) out.push({ variant: w.id, skip: 'several settings at once and none of them wins on its own' });
    else if (!editableKey(key)) out.push({ variant: w.id, skip: `${key} is not a single editable setting — the owner decides` });
    else out.push({ variant: w.id, key, value: over[key] });
  }
  return out;
}

/** Pure: when full, which open key to evict — the oldest position of the variant with the most open. */
export function evictionKey(open: ReadonlyMap<string, { variant: string; openedAt: number }>): string | null {
  const count = new Map<string, number>();
  for (const o of open.values()) count.set(o.variant, (count.get(o.variant) ?? 0) + 1);
  let top: string | null = null;
  for (const [v, n] of count) if (top === null || n > count.get(top)!) top = v;
  if (top === null) return null;
  let key: string | null = null;
  let at = Infinity;
  for (const [k, o] of open) if (o.variant === top && o.openedAt < at) ((key = k), (at = o.openedAt));
  return key;
}

// ───────────────────────────── the tournament ─────────────────────────────

export interface LoopOfferTarget {
  offer: (o: { key: string; value: number | boolean; source: 'tournament'; evidence: string }) => Promise<{ queued: boolean; why: string }>;
}

export class Tournament {
  private readonly book: VirtualBook;
  private readonly openMeta = new Map<string, { variant: string; openedAt: number }>();
  private readonly lastOpen = new Map<string, number>();
  private readonly rulesCache = new WeakMap<object, Map<string, ExitRules>>();
  private timer: NodeJS.Timeout | null = null;
  private judgeTimer: NodeJS.Timeout | null = null;
  /** The self-improving loop (set in index.ts). Winners are offered to it, never applied here. */
  loop: LoopOfferTarget | null = null;

  constructor(
    private readonly redis: Redis,
    crowd: CrowdTracker,
    private readonly rng: () => number = Math.random,
  ) {
    this.book = new VirtualBook(
      crowd,
      (tag, live) => this.rulesFor(String(tag.variant), live),
      (r) => this.onClosed(r),
      () => Number.MAX_SAFE_INTEGER,
    );
  }

  cfg(): TournamentConfig {
    return ((getConfig() as { tournament?: TournamentConfig }).tournament ?? DEFAULT_CONFIG.tournament) as TournamentConfig;
  }

  private sniperCfg(): SniperConfig {
    return (getConfig().sniper ?? DEFAULT_CONFIG.sniper) as SniperConfig;
  }

  private rulesFor(id: string, live: ExitRules): ExitRules | null {
    const v = this.cfg().variants.find((x) => x.id === id);
    if (!v) return null;
    const sn = this.sniperCfg().exits;
    const ck = `${v.id}|${JSON.stringify(v.exitOverrides)}|${JSON.stringify(sn)}`;
    let m = this.rulesCache.get(live);
    if (!m) this.rulesCache.set(live, (m = new Map()));
    let r = m.get(ck);
    if (!r) m.set(ck, (r = variantExitRules(live, v, sn)));
    return r;
  }

  start(): void {
    this.timer = setInterval(() => this.book.stepAll(), 1_000);
    this.timer.unref?.();
    this.judgeTimer = setInterval(() => void this.refresh(), 10 * 60_000);
    this.judgeTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.judgeTimer) clearInterval(this.judgeTimer);
  }

  openCount(): number {
    return this.book.size;
  }

  /** A trade on `mint` (token registry): step its virtual positions. */
  onTrade(mint: string, now = Date.now()): void {
    this.book.onTrade(mint, now);
  }

  /** One scored coin from the evaluator. Pure checks only (≤ a few ms for every variant). */
  onCandidate(c: TournamentCandidate, now = Date.now()): number {
    const cfg = this.cfg();
    if (!cfg.enabled || !(c.priceSol > 0) || c.hardFail) return 0;
    if (cfg.onlyEnabledStrategies && !c.strategyEnabled) return 0;
    let opened = 0;
    const cand = isCandidate(c);
    const sniper = this.sniperCfg();
    const mg = (getConfig().momentumGate ?? DEFAULT_CONFIG.momentumGate) as MomentumGateConfig;
    for (const v of cfg.variants) {
      if (v.random) {
        if (this.rng() >= 1 / Math.max(1, cfg.randomEvery)) continue;
      } else {
        if (!cand) continue;
        if (variantEntryFails(c, v, sniper, mg).length) continue;
      }
      if (this.open(v.id, c, now)) opened++;
    }
    if (this.lastOpen.size > 50_000) for (const [k, t] of this.lastOpen) if (now - t > cfg.cooldownMin * 60_000) this.lastOpen.delete(k);
    return opened;
  }

  private open(variant: string, c: TournamentCandidate, now: number): boolean {
    const cfg = this.cfg();
    const ck = `${variant}:${c.mint}`;
    if (now - (this.lastOpen.get(ck) ?? -Infinity) < cfg.cooldownMin * 60_000) return false;
    while (this.openMeta.size >= cfg.maxOpen) {
      const k = evictionKey(this.openMeta);
      if (!k) break;
      this.book.remove(k);
      this.openMeta.delete(k);
    }
    const key = `${variant}:${c.mint}:${now.toString(36)}`;
    const ok = this.book.add({ key, mint: c.mint, symbol: c.symbol, strategy: c.strategy, onAmm: c.onAmm, priceSol: c.priceSol, tag: { variant } }, now);
    if (!ok) return false;
    this.lastOpen.set(ck, now);
    this.openMeta.set(key, { variant, openedAt: now });
    return true;
  }

  private onClosed(v: VirtualResult): void {
    this.openMeta.delete(v.key);
    const r: TournamentResult = { variant: String(v.tag.variant), mint: v.mint, symbol: v.symbol, strategy: v.strategy, pnlPct: v.pnlPct, peakX: v.peakX, holdSec: v.holdSec, reason: v.reason, at: v.at };
    const keep = this.cfg().keepResults;
    void this.redis.multi().lpush(resKey(r.variant), JSON.stringify(r)).ltrim(resKey(r.variant), 0, keep - 1).exec().catch((err: Error) => log.warn({ err: err.message }, 'tournament result not saved'));
  }

  async results(id: string): Promise<TournamentResult[]> {
    const raw = await this.redis.lrange(resKey(id), 0, this.cfg().keepResults - 1);
    const out: TournamentResult[] = [];
    for (const x of raw) {
      try {
        out.push(JSON.parse(x) as TournamentResult);
      } catch {
        /* skip a bad row */
      }
    }
    return out;
  }

  /** Stats per variant + winners; offers winners to the self-improving loop. Cached in `tour:stats`. */
  async refresh(now = Date.now()): Promise<void> {
    const cfg = this.cfg();
    if (!cfg.enabled) return;
    try {
      const rows = new Map<string, number[]>();
      for (const v of cfg.variants) rows.set(v.id, (await this.results(v.id)).map((r) => r.pnlPct));
      const j = judge(cfg.variants, rows, cfg);
      await this.redis.set(STATS_KEY, JSON.stringify({ at: now, ...j }), 'EX', 3 * 86_400);
      if (!this.loop) return;
      for (const o of offersFor(cfg.variants, j.rows)) {
        if ('skip' in o) continue;
        if (typeof o.value !== 'number' && typeof o.value !== 'boolean') continue;
        const row = j.rows.find((r) => r.id === o.variant)!;
        const evidence = `tournament: "${row.name}" ${row.n} virtual trades, avg ${row.avgPnlPct}%/trade (${row.vsBaselinePts !== null ? `${row.vsBaselinePts >= 0 ? '+' : ''}${row.vsBaselinePts} pts vs ${j.baseline}` : 'vs zero'}), q ${row.q}`;
        const res = await this.loop.offer({ key: o.key, value: o.value, source: 'tournament', evidence }).catch((e: Error) => ({ queued: false, why: e.message }));
        const rec: Offer = { variant: o.variant, key: o.key, value: o.value, at: now, result: res.queued ? 'offered to the loop' : res.why };
        await this.redis.multi().lpush(OFFERS_KEY, JSON.stringify(rec)).ltrim(OFFERS_KEY, 0, 49).exec();
        if (res.queued) log.info({ key: o.key, value: o.value }, `🏆 tournament winner offered to the loop: ${evidence}`);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'tournament refresh failed');
    }
  }

  /** GET /api/tournament: the table, the baseline, the winners, what was offered. */
  async report(now = Date.now()): Promise<{ enabled: boolean; at: number; baseline: string; rows: VariantRow[]; open: number; minResults: number; offers: Offer[] }> {
    const cfg = this.cfg();
    const rows = new Map<string, number[]>();
    for (const v of cfg.variants) rows.set(v.id, (await this.results(v.id)).map((r) => r.pnlPct));
    const j = judge(cfg.variants, rows, cfg);
    const offers = (await this.redis.lrange(OFFERS_KEY, 0, 19)).map((x) => JSON.parse(x) as Offer);
    return { enabled: cfg.enabled, at: now, baseline: j.baseline, rows: j.rows, open: this.book.size, minResults: cfg.minResults, offers };
  }
}
