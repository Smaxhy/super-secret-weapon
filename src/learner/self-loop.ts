/**
 * Self-improving loop (v11.13; owner: "the bot improves itself with proof while I sleep").
 *
 * Once a day (and on the owner's Run button) ONE setting change is:
 *   1. proposed — by the AI coach (`proposeOne`), else by a deterministic proposer that reads Bot health: the rule that
 *      blocks most among strategies that pass every rule but never signal, or the top rule fail after 6 h without a buy;
 *   2. PROVEN on the recorded market — the replay runs twice on the last `tapeDays` (baseline = saved config,
 *      candidate = baseline + the change) and the candidate must beat the baseline after costs;
 *   3. applied (`applyEdit`, source 'loop', change log);
 *   4. watched on real closed trades and reverted (source 'loop-revert') when live does clearly worse than the replay
 *      promised AND worse than before the change.
 * One experiment at a time, a cooldown between experiments, and only keys the replay can actually evaluate.
 */
import { EDITABLE, checkEdit, type EditableSetting } from '../config/editable';
import type { BlockerSnapshot } from '../lib/entry-blockers';
import { moduleLogger } from '../lib/logger';
import type { ReplayReport } from './replay';

const log = moduleLogger('self-loop');

export const LOOP_STATE_KEY = 'loop:state';

export interface LoopConfig {
  enabled: boolean;
  hourUtc: number;
  tapeDays: number;
  minTapeHours: number;
  minTradesBoth: number;
  minEdgeSol: number;
  minEdgePctPts: number;
  maxPfDrop: number;
  watchTrades: number;
  watchHours: number;
  revertIfWorsePts: number;
  cooldownHours: number;
  allowedKeys: readonly string[];
  maxStepPct: number;
  allowLive: boolean;
}

export const DEFAULT_LOOP: LoopConfig = {
  enabled: true,
  hourUtc: 5,
  tapeDays: 2,
  minTapeHours: 24,
  minTradesBoth: 8,
  minEdgeSol: 0.1,
  minEdgePctPts: 2,
  maxPfDrop: 0.15,
  watchTrades: 12,
  watchHours: 48,
  revertIfWorsePts: 3,
  cooldownHours: 20,
  allowedKeys: [],
  maxStepPct: 30,
  allowLive: false,
};

export interface ReplaySummary {
  trades: number;
  totalSol: number;
  avgPct: number;
  profitFactor: number | null;
  winRatePct: number;
}

export interface Proposal {
  key: string;
  value: number | boolean;
  why: string;
  source: 'ai' | 'rules';
}

export interface Experiment {
  id: string;
  key: string;
  label: string;
  from: number | boolean | null;
  to: number | boolean;
  why: string;
  source: 'ai' | 'rules';
  proposedAt: number;
  status: 'proving' | 'rejected' | 'watching' | 'kept' | 'reverted';
  statusWhy: string;
  appliedAt?: number;
  finishedAt?: number;
  replay?: { base: ReplaySummary; cand: ReplaySummary; fromMs: number; toMs: number };
  live?: { n: number; avgPct: number | null; preAvgPct: number | null };
}

export interface LoopState {
  current: Experiment | null;
  history: Experiment[];
  lastRunDay: string | null;
  lastFinishedAt: number | null;
  lastResult: { at: number; text: string } | null;
}

export const emptyState = (): LoopState => ({ current: null, history: [], lastRunDay: null, lastFinishedAt: null, lastResult: null });

// ───────────────────────────── which keys the loop may touch ─────────────────────────────

/** Settings the replay really evaluates (owner filters, strategy minimums, gates, sniper, wallet/deployer entry, exits). */
const REPLAYABLE = ['ownerFilters.', 'focus.migrated.', 'focus.soon.', 'focus.newPair.', 'momentumGate.', 'entryQuality.', 'entry.pressure.', 'entry.minCombinedScore', 'entry.minHolders', 'sniper.', 'exit.', 'wallets.entry.', 'deployers.', 'runner.scan.'];
const EXCLUDED = [/^usage\./, /^obsidian\./, /^paper\./, /^live\./, /^trading\.enabledStrategies\./, /^sniper\.enabled$/, /^loop\./, /\.enabled$/];
/** Trade sizes: the loop may only make them smaller. */
const SIZE_KEY = /(sizeSol|PositionSol|sizeMultiplier|allocation)/;

export function keyAllowed(key: string, c: Pick<LoopConfig, 'allowedKeys'>): { ok: boolean; why: string } {
  if (!EDITABLE.some((e) => e.key === key)) return { ok: false, why: `${key} is not an editable setting` };
  if (EXCLUDED.some((r) => r.test(key))) return { ok: false, why: `${key} is never changed by the loop` };
  if (c.allowedKeys.length) return c.allowedKeys.includes(key) ? { ok: true, why: '' } : { ok: false, why: `${key} is not in loop.allowedKeys` };
  if (!REPLAYABLE.some((p) => key.startsWith(p))) return { ok: false, why: `${key} can't be proven on the tape (the replay doesn't evaluate it)` };
  return { ok: true, why: '' };
}

/** Pure: is this change allowed and safe? Rounds to the setting's step. */
export function validateChange(p: { key: string; value: number | boolean }, current: unknown, c: Pick<LoopConfig, 'allowedKeys' | 'maxStepPct'>): { ok: true; value: number | boolean; setting: EditableSetting } | { ok: false; why: string } {
  const allowed = keyAllowed(p.key, c);
  if (!allowed.ok) return { ok: false, why: allowed.why };
  const raw = typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value;
  const setting = EDITABLE.find((e) => e.key === p.key)!;
  const step = setting.step && setting.step > 0 ? setting.step : 0;
  const rounded = step ? Math.round(raw / step) * step : raw;
  const value = Math.round(rounded * 1e6) / 1e6;
  const chk = checkEdit(p.key, value);
  if (!chk.ok) return { ok: false, why: chk.error };
  const cur = typeof current === 'boolean' ? (current ? 1 : 0) : typeof current === 'number' ? current : null;
  if (cur !== null && Math.abs(cur - value) < 1e-9) return { ok: false, why: `${p.key} is already ${value}` };
  if (cur !== null && SIZE_KEY.test(p.key) && value > cur) return { ok: false, why: `${p.key}: the loop may only make sizes smaller` };
  const range = setting.max - setting.min;
  if (cur !== null && range > 0 && Math.abs(value - cur) > (c.maxStepPct / 100) * range + 1e-9) return { ok: false, why: `${p.key}: ${cur} → ${value} moves more than ${c.maxStepPct}% of its range` };
  return { ok: true, value: chk.value, setting };
}

// ───────────────────────────── deterministic proposer ─────────────────────────────

type Dir = 'down' | 'up';
interface RuleKey { key: string; dir: Dir }

const STRATEGY_PREFIX: Record<string, string> = { MIGRATION_MOMENTUM: 'focus.migrated', SOON: 'focus.soon', CURVE_SNIPE: 'focus.newPair' };

/** Pure: which setting a (normalised) skip reason comes from, for a strategy — or null when the loop can't relax it. */
export function settingForSkip(strategy: string, reason: string): RuleKey | null {
  const r = reason.toLowerCase();
  if (r.includes('too close to the top')) return { key: 'momentumGate.minOffHighPct', dir: 'down' };
  if (r.startsWith('chasing') && r.includes('last minute')) return { key: 'momentumGate.maxRun1mPct', dir: 'up' };
  if (r.startsWith('chasing') && r.includes('min')) return { key: 'momentumGate.maxRun3mPct', dir: 'up' };
  if (r.includes('sellers winning: buy share')) return { key: 'momentumGate.minBuyShare2m', dir: 'down' };
  if (r.includes('buying the tip')) return { key: 'momentumGate.maxLastCandlePct', dir: 'up' };
  if (r.includes('real buyers in') && r.includes('min')) return { key: 'sniper.volume.minBuyers', dir: 'down' };
  if (r.includes('sol bought in') && r.includes('min')) return { key: 'sniper.volume.minBuySol', dir: 'down' };
  if (r.includes('over the bar')) return { key: 'sniper.minScoreMargin', dir: 'down' };
  if (r.includes('buys only') && r.includes('of volume')) return { key: 'sniper.volume.minBuySharePct', dir: 'down' };
  if (r.includes('organic volume')) return { key: 'sniper.volume.minOrganicPct', dir: 'down' };
  if (r.includes('active wallets')) {
    if (strategy === 'MIGRATION_MOMENTUM') return { key: 'focus.migrated.minActiveWallets5m', dir: 'down' };
    if (strategy === 'SOON') return { key: 'focus.soon.minActiveWallets5m', dir: 'down' };
    return null;
  }
  if (/^holders # < #/.test(r)) {
    if (strategy === 'MIGRATION_MOMENTUM') return { key: 'entry.minHoldersMigration', dir: 'down' };
    if (strategy === 'SOON') return { key: 'focus.soon.minHolders', dir: 'down' };
    if (strategy === 'CURVE_SNIPE') return { key: 'focus.newPair.minHolders', dir: 'down' };
    return null;
  }
  if (r.includes('score under the bar')) return scoreBarKey(strategy);
  return null;
}

function scoreBarKey(strategy: string): RuleKey {
  const p = STRATEGY_PREFIX[strategy];
  return p && p !== 'focus.newPair' ? { key: `${p}.scoreThresholdDelta`, dir: 'down' } : { key: 'entry.minCombinedScore', dir: 'down' };
}

/** Pure: one relaxing step = 20% of the gap to the setting's limit, at least one editable step. */
export function relaxStep(setting: EditableSetting, current: number, dir: Dir): number {
  const limit = dir === 'down' ? setting.min : setting.max;
  const gap = limit - current;
  if (Math.abs(gap) < 1e-9) return current;
  let move = gap * 0.2;
  const step = setting.step && setting.step > 0 ? setting.step : 0;
  if (step && Math.abs(move) < step) move = Math.sign(gap) * step;
  const next = current + move;
  return step ? Math.round(next / step) * step : next;
}

/**
 * Pure: the deterministic proposal from Bot health (last hour). Strategies that pass every rule ≥20 times but never
 * signal → their top relaxable skip, else their score bar; or, after 6 h without a buy, the top relaxable skip of any
 * switched-on strategy.
 */
export function proposeFromHealth(snap: Pick<BlockerSnapshot, 'strategies' | 'minutesSinceEntry'>, current: (key: string) => unknown, c: Pick<LoopConfig, 'allowedKeys' | 'maxStepPct'>): Proposal | null {
  const stuck = snap.strategies.filter((s) => s.on !== false && s.rulesOk >= 20 && s.signal === 0);
  const pools: Array<{ strategy: string; reason: string; count: number }> = [];
  for (const s of stuck) {
    for (const sk of s.topSkips) pools.push({ strategy: s.strategy, reason: sk.reason, count: sk.count });
    pools.push({ strategy: s.strategy, reason: 'score under the bar', count: s.rulesOk });
  }
  if (!pools.length && snap.minutesSinceEntry >= 360) {
    for (const s of snap.strategies.filter((x) => x.on !== false)) for (const sk of s.topSkips) pools.push({ strategy: s.strategy, reason: sk.reason, count: sk.count });
  }
  pools.sort((a, b) => b.count - a.count);
  for (const p of pools) {
    const rk = settingForSkip(p.strategy, p.reason);
    if (!rk) continue;
    const setting = EDITABLE.find((e) => e.key === rk.key);
    const cur = current(rk.key);
    if (!setting || typeof cur !== 'number') continue;
    const value = relaxStep(setting, cur, rk.dir);
    const v = validateChange({ key: rk.key, value }, cur, c);
    if (!v.ok) continue;
    return { key: rk.key, value: v.value, source: 'rules', why: `${p.strategy}: "${p.reason}" ×${p.count} in the last hour${stuck.some((s) => s.strategy === p.strategy) ? ' (passes every rule but never signals)' : ' (no buy for 6 h+)'} — ${setting.label} ${cur} → ${v.value}` };
  }
  return null;
}

// ───────────────────────────── proof + watch ─────────────────────────────

export function summarise(r: Pick<ReplayReport, 'trades' | 'totalSol' | 'avgPct' | 'profitFactor' | 'winRatePct'>): ReplaySummary {
  return { trades: r.trades, totalSol: r.totalSol, avgPct: r.avgPct, profitFactor: r.profitFactor, winRatePct: r.winRatePct };
}

/** Pure: did the candidate beat the baseline on the tape? */
export function acceptVerdict(base: ReplaySummary, cand: ReplaySummary, c: Pick<LoopConfig, 'minTradesBoth' | 'minEdgeSol' | 'minEdgePctPts' | 'maxPfDrop'>): { accept: boolean; why: string } {
  const pf = (x: ReplaySummary) => x.profitFactor ?? (x.totalSol > 0 ? 99 : 0);
  const line = `replay: ${base.trades} → ${cand.trades} trades, ${base.totalSol.toFixed(2)} → ${cand.totalSol.toFixed(2)} SOL, avg ${base.avgPct}% → ${cand.avgPct}%, PF ${base.profitFactor ?? '—'} → ${cand.profitFactor ?? '—'}`;
  if (base.trades === 0) {
    if (cand.trades >= c.minTradesBoth && cand.totalSol > 0 && pf(cand) >= 1) return { accept: true, why: `the current rules took no trades on the tape; the change takes ${cand.trades} and makes money — ${line}` };
    return { accept: false, why: `not enough proof (the change needs ≥${c.minTradesBoth} trades, profit and PF ≥1) — ${line}` };
  }
  if (cand.trades < c.minTradesBoth) return { accept: false, why: `only ${cand.trades} trades with the change (needs ${c.minTradesBoth}) — ${line}` };
  if (cand.totalSol <= 0) return { accept: false, why: `the change still loses money — ${line}` };
  if (pf(cand) < pf(base) - c.maxPfDrop) return { accept: false, why: `profit factor drops too much — ${line}` };
  const solBetter = cand.totalSol - base.totalSol >= c.minEdgeSol;
  const pctBetter = cand.avgPct >= base.avgPct + c.minEdgePctPts && cand.totalSol >= base.totalSol;
  if (!solBetter && !pctBetter) return { accept: false, why: `not clearly better than today's rules — ${line}` };
  return { accept: true, why: line };
}

/** Pure: after the change went live — keep watching, keep it, or revert it. */
export function watchVerdict(w: { n: number; avgPct: number | null; replayAvgPct: number; preAvgPct: number | null; elapsedMs: number }, c: Pick<LoopConfig, 'watchTrades' | 'watchHours' | 'revertIfWorsePts'>): { action: 'wait' | 'keep' | 'revert'; why: string } {
  const timeUp = w.elapsedMs >= c.watchHours * 3600_000;
  if (w.n < c.watchTrades && !timeUp) return { action: 'wait', why: `${w.n}/${c.watchTrades} live trades so far` };
  if (w.n === 0 || w.avgPct === null) return { action: 'keep', why: `no live trades in ${c.watchHours} h to judge it by — kept` };
  const worseThanReplay = w.avgPct < w.replayAvgPct - c.revertIfWorsePts;
  const worseThanBefore = w.preAvgPct === null || w.avgPct < w.preAvgPct;
  if (worseThanReplay && worseThanBefore) return { action: 'revert', why: `live ${w.avgPct}%/trade over ${w.n} trades vs ${w.replayAvgPct}% in the replay${w.preAvgPct !== null ? ` and ${w.preAvgPct}% before the change` : ''}` };
  return { action: 'keep', why: `live ${w.avgPct}%/trade over ${w.n} trades (replay ${w.replayAvgPct}%${w.preAvgPct !== null ? `, before ${w.preAvgPct}%` : ''})` };
}

/** Which strategy a key belongs to (its live trades judge it), null = all. */
export function strategyOfKey(key: string): string | null {
  if (key.startsWith('focus.migrated.') || key.startsWith('ownerFilters.migrated.') || key === 'entry.minHoldersMigration') return 'MIGRATION_MOMENTUM';
  if (key.startsWith('focus.soon.') || key.startsWith('ownerFilters.soon.')) return 'SOON';
  if (key.startsWith('focus.newPair.') || key.startsWith('ownerFilters.newPair.') || key === 'entry.minHoldersCurveSnipe') return 'CURVE_SNIPE';
  const m = /\.(MIGRATION_MOMENTUM|SOON|CURVE_SNIPE|RUNNER|SWING|SMART_MONEY_COPY)$/.exec(key);
  return m ? m[1]! : null;
}

const avg = (xs: readonly number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

// ───────────────────────────── the loop ─────────────────────────────

export interface LoopDeps {
  cfg: () => LoopConfig;
  current: (key: string) => unknown;
  health: () => Pick<BlockerSnapshot, 'strategies' | 'minutesSinceEntry'>;
  proposeAi?: (ctx: { health: unknown; history: Experiment[] }) => Promise<{ key: string; value: number; why: string } | null>;
  /** Runs the replay in the child-process runner and waits for its report (null = failed / busy). */
  runReplay: (set: string[], fromMs: number, toMs: number) => Promise<ReplayReport | null>;
  replayRunning: () => boolean;
  tapeStartMs: () => Promise<number | null>;
  apply: (key: string, value: number | boolean, source: 'loop' | 'loop-revert', why: string) => Promise<{ ok: boolean; error?: string }>;
  /** % P&L of closed real trades (oldest first) between the times, optionally one strategy, newest `limit`. */
  liveTrades: (q: { sinceMs?: number; untilMs?: number; strategy: string | null; limit?: number }) => Promise<number[]>;
  load: () => Promise<string | null>;
  save: (raw: string) => Promise<void>;
  liveMode: () => boolean;
  note?: (atMs: number, title: string, lines: string[]) => Promise<void>;
  remember?: (bullet: string) => Promise<void>;
  now?: () => number;
}

export class SelfLoop {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly d: LoopDeps) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  async state(): Promise<LoopState> {
    try {
      const raw = await this.d.load();
      return raw ? { ...emptyState(), ...(JSON.parse(raw) as LoopState) } : emptyState();
    } catch {
      return emptyState();
    }
  }

  private async put(s: LoopState): Promise<void> {
    s.history = s.history.slice(0, 20);
    await this.d.save(JSON.stringify(s)).catch(() => undefined);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 10 * 60_000);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 90_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Every 10 min: watch the open experiment; once a day at `hourUtc` start a new one. */
  async tick(): Promise<void> {
    await this.watch();
    const c = this.d.cfg();
    const now = new Date(this.now());
    const s = await this.state();
    if (c.enabled && now.getUTCHours() === c.hourUtc && s.lastRunDay !== now.toISOString().slice(0, 10)) await this.runOnce(false);
  }

  private async finish(s: LoopState, e: Experiment, status: Experiment['status'], why: string): Promise<void> {
    e.status = status;
    e.statusWhy = why;
    e.finishedAt = this.now();
    s.current = null;
    s.history.unshift(e);
    if (status === 'kept' || status === 'reverted' || (status === 'rejected' && e.appliedAt)) s.lastFinishedAt = e.finishedAt;
    s.lastResult = { at: e.finishedAt, text: `${e.label}: ${status} — ${why}` };
    await this.put(s);
  }

  /** One experiment: propose → prove → apply. `ownerAsked` = the dashboard's Run button (skips the cooldown). */
  async runOnce(ownerAsked: boolean): Promise<{ ran: boolean; why: string }> {
    const c = this.d.cfg();
    const now = this.now();
    const s = await this.state();
    const skip = async (why: string) => {
      s.lastResult = { at: now, text: why };
      if (!ownerAsked) s.lastRunDay = new Date(now).toISOString().slice(0, 10);
      await this.put(s);
      return { ran: false, why };
    };
    if (!c.enabled) return { ran: false, why: 'the loop is switched off' };
    if (this.d.liveMode() && !c.allowLive) return { ran: false, why: 'live trading — the loop only runs in paper unless loop.allowLive is on' };
    if (this.busy) return { ran: false, why: 'the loop is already running' };
    if (s.current) return { ran: false, why: `still watching "${s.current.label}" (${s.current.statusWhy})` };
    if (!ownerAsked && s.lastFinishedAt && now - s.lastFinishedAt < c.cooldownHours * 3600_000) return skip(`cooling down after the last experiment (${c.cooldownHours} h)`);
    if (this.d.replayRunning()) return { ran: false, why: 'another replay is running — try again when it ends' };
    const tape0 = await this.d.tapeStartMs().catch(() => null);
    const toMs = now;
    const fromMs = Math.max(now - c.tapeDays * 86_400_000, tape0 ?? now);
    const hours = (toMs - fromMs) / 3600_000;
    if (tape0 === null || hours < c.minTapeHours) return skip(`only ${hours.toFixed(0)} h of recorded market (needs ${c.minTapeHours} h)`);

    this.busy = true;
    try {
      // 1. propose
      const health = this.d.health();
      let proposal: Proposal | null = null;
      const rejected: string[] = [];
      if (this.d.proposeAi) {
        const ai = await this.d.proposeAi({ health, history: s.history.slice(0, 10) }).catch(() => null);
        if (ai) {
          const v = validateChange(ai, this.d.current(ai.key), c);
          if (v.ok) proposal = { key: ai.key, value: v.value, why: ai.why, source: 'ai' };
          else rejected.push(`AI idea ${ai.key}=${ai.value} refused: ${v.why}`);
        }
      }
      if (!proposal) proposal = proposeFromHealth(health, this.d.current, c);
      if (!proposal) return skip(`nothing to try${rejected.length ? ` (${rejected.join('; ')})` : ''} — no rule is clearly blocking`);
      const setting = EDITABLE.find((x) => x.key === proposal.key)!;
      const from = this.d.current(proposal.key);
      const e: Experiment = {
        id: `x${now.toString(36)}`,
        key: proposal.key,
        label: `${setting.group}: ${setting.label}`,
        from: typeof from === 'number' || typeof from === 'boolean' ? from : null,
        to: proposal.value,
        why: proposal.why,
        source: proposal.source,
        proposedAt: now,
        status: 'proving',
        statusWhy: 'replaying the recorded market',
      };
      s.current = e;
      s.lastRunDay = new Date(now).toISOString().slice(0, 10);
      await this.put(s);
      await this.d.note?.(now, `Loop — trying ${e.label}`, [`${String(e.from)} → ${String(e.to)} (${e.source === 'ai' ? 'AI idea' : 'from Bot health'}): ${e.why}`, ...rejected]).catch(() => undefined);

      // 2. prove
      const base = await this.d.runReplay([], fromMs, toMs);
      const cand = base ? await this.d.runReplay([`${e.key}=${String(e.to)}`], fromMs, toMs) : null;
      if (!base || !cand) {
        await this.finish(s, e, 'rejected', 'the replay failed or was busy');
        return { ran: true, why: 'replay failed' };
      }
      e.replay = { base: summarise(base), cand: summarise(cand), fromMs, toMs };
      const v = acceptVerdict(e.replay.base, e.replay.cand, c);
      if (!v.accept) {
        await this.finish(s, e, 'rejected', v.why);
        await this.d.note?.(this.now(), `Loop — rejected ${e.label}`, [v.why]).catch(() => undefined);
        return { ran: true, why: `rejected: ${v.why}` };
      }

      // 3. apply
      const strategy = strategyOfKey(e.key);
      const pre = await this.d.liveTrades({ untilMs: this.now(), strategy, limit: 30 }).catch(() => [] as number[]);
      const res = await this.d.apply(e.key, e.to, 'loop', `self-improving loop: proven on ${hours.toFixed(0)} h of recorded market — ${v.why}`);
      if (!res.ok) {
        await this.finish(s, e, 'rejected', `could not apply: ${res.error ?? 'unknown'}`);
        return { ran: true, why: `could not apply: ${res.error}` };
      }
      e.appliedAt = this.now();
      e.live = { n: 0, avgPct: null, preAvgPct: avg(pre) };
      e.status = 'watching';
      e.statusWhy = `applied — watching ${c.watchTrades} live trades or ${c.watchHours} h`;
      s.current = e;
      s.lastResult = { at: e.appliedAt, text: `${e.label} ${String(e.from)} → ${String(e.to)} applied — ${v.why}` };
      await this.put(s);
      await this.d.note?.(e.appliedAt, `Loop — applied ${e.label}`, [`${String(e.from)} → ${String(e.to)}`, v.why]).catch(() => undefined);
      await this.d.remember?.(`loop: ${e.key} ${String(e.from)}→${String(e.to)} proven on the tape (${e.replay.base.totalSol.toFixed(2)} → ${e.replay.cand.totalSol.toFixed(2)} SOL) — now watching live`).catch(() => undefined);
      log.info({ key: e.key, from: e.from, to: e.to }, `🔁 loop applied a proven change: ${v.why}`);
      return { ran: true, why: `applied ${e.label} ${String(e.from)} → ${String(e.to)}` };
    } finally {
      this.busy = false;
    }
  }

  /** Watch the applied change on live trades; keep or revert it. */
  async watch(): Promise<void> {
    const s = await this.state();
    const e = s.current;
    if (!e || e.status !== 'watching' || !e.appliedAt || !e.replay) return;
    const c = this.d.cfg();
    const pnl = await this.d.liveTrades({ sinceMs: e.appliedAt, strategy: strategyOfKey(e.key) }).catch(() => [] as number[]);
    e.live = { n: pnl.length, avgPct: avg(pnl), preAvgPct: e.live?.preAvgPct ?? null };
    const w = watchVerdict({ n: pnl.length, avgPct: e.live.avgPct, replayAvgPct: e.replay.cand.avgPct, preAvgPct: e.live.preAvgPct, elapsedMs: this.now() - e.appliedAt }, c);
    if (w.action === 'wait') {
      e.statusWhy = w.why;
      await this.put(s);
      return;
    }
    if (w.action === 'revert') {
      const res = await this.d.apply(e.key, e.from as number | boolean, 'loop-revert', `self-improving loop: ${w.why} — back to ${String(e.from)}`);
      await this.finish(s, e, 'reverted', res.ok ? w.why : `${w.why} (revert failed: ${res.error ?? 'unknown'})`);
      await this.d.note?.(this.now(), `Loop — reverted ${e.label}`, [`back to ${String(e.from)}`, w.why]).catch(() => undefined);
      await this.d.remember?.(`loop: ${e.key} ${String(e.from)}→${String(e.to)} looked good on the tape but ${w.why} — reverted`).catch(() => undefined);
      log.info({ key: e.key }, `🔁 loop reverted: ${w.why}`);
      return;
    }
    await this.finish(s, e, 'kept', w.why);
    await this.d.note?.(this.now(), `Loop — kept ${e.label}`, [w.why]).catch(() => undefined);
    await this.d.remember?.(`loop: ${e.key} ${String(e.from)}→${String(e.to)} proven on the tape, ${w.why} — kept`).catch(() => undefined);
  }
}
