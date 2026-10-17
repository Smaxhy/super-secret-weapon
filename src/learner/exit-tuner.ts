/**
 * Exit tuner (owner: "make the brain operate better — stale exits, more concrete data, new rules on its own with
 * minimal Claude credits"). Pure statistics, no AI call.
 *
 * Every time-based exit (no follow-through, stalled, no movement = stale, max hold) is followed for 30 minutes after
 * the sell, from the live trade log: how high did the coin go after we sold (maxAfterX), how low (minAfterX), where it
 * ended (endX) — all × our exit price. Then per strategy × timer:
 *   - ≥ `ranAfterPct`% of those exits ran ≥ +25% after we sold → we sell too soon: that timer ×1.25 (≤ 3× default)
 *   - ≤ `deadAfterPct`% ran and the typical coin ended ≥ 5% lower → the timer is right or too slow: ×0.85 (≥ 0.5× default)
 * at most once per strategy+timer per `minHoursBetween`, with ≥ `minExits` exits since the last change. Every change goes
 * to "What the bot changed"; the summary goes to the AI coach (`exitsAfterSelling`) and the Brain page.
 */
import type { Redis } from 'ioredis';
import { sniperOn } from '../config/sniper';
import { DEFAULT_CONFIG } from '../config/default';
import { applyEdit } from '../config/apply-edit';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { CrowdTrade } from '../scanner/crowd-tracker';

const log = moduleLogger('exit-tuner');
const K = { done: 'exitafter:done', res: 'exitafter:res', loss: 'exitafter:loss', changed: (k: string) => `exitafter:chg:${k}` };

export type ExitTimer = 'timeStop' | 'stall' | 'stale' | 'maxHold';
/** The config map each timer reads (exit.<path>.<STRATEGY>). */
export const TIMER_PATH: Record<ExitTimer, string> = { timeStop: 'exit.timeStop.minutes', stall: 'exit.timeStop.stallMinutes', stale: 'exit.staleMinutes', maxHold: 'exit.maxHoldMinutes' };
export const TIMER_LABEL: Record<ExitTimer, string> = { timeStop: 'no follow-through timer', stall: 'stall timer', stale: 'stale (no movement) timer', maxHold: 'max hold' };

export interface ExitAfter {
  id: string;
  strategy: string;
  timer: ExitTimer;
  closedAtMs: number;
  exitPriceSol: number;
  pnlPct: number;
  maxAfterX: number;
  minAfterX: number;
  endX: number;
  trades: number;
}

export interface ExitTunerConfig {
  enabled: boolean;
  watchMin: number;
  minExits: number;
  ranAfterPct: number;
  deadAfterPct: number;
  minHoursBetween: number;
  maxFactor: number;
  minFactor: number;
  /** Loss exits (stops + rug exits): judged with ≥ minExits; chart rug exits re-tuned when allowed. */
  lossExits?: { enabled: boolean; minExits: number; falseAlarmPct: number; maxDiedPct: number; lateOvershootPts: number; tuneRugExits: boolean; step: number };
}

/** Pure: which timer closed the trade, from the sell's reason text. */
export function timerOf(reason: string): ExitTimer | null {
  const r = reason.toLowerCase();
  if (r.includes('no follow-through')) return 'timeStop';
  if (r.includes('stalled')) return 'stall';
  if (r.includes('max hold')) return 'maxHold';
  if (r.includes('no movement')) return 'stale';
  return null;
}

/** Pure: what the price did in `watchMs` after the exit, × the exit price. Null with < 3 trades after. */
export function afterExit(trades: readonly CrowdTrade[], closedAtMs: number, exitPriceSol: number, watchMs: number): { maxAfterX: number; minAfterX: number; endX: number; trades: number } | null {
  if (!(exitPriceSol > 0)) return null;
  let max = 0;
  let min = Infinity;
  let end = 0;
  let n = 0;
  for (const t of trades) {
    if (t.t <= closedAtMs || t.t > closedAtMs + watchMs) continue;
    const px = t.pp && t.pp > 0 ? t.pp : t.px;
    if (!(px > 0)) continue;
    max = Math.max(max, px);
    min = Math.min(min, px);
    end = px;
    n++;
  }
  if (n < 3) return null;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { maxAfterX: r2(max / exitPriceSol), minAfterX: r2(min / exitPriceSol), endX: r2(end / exitPriceSol), trades: n };
}

/**
 * Loss exits (review: "stop loss and rug detected are most of the losses — find out if it's a bad entry, a late
 * rug exit, unrealistic paper fills or an exit that came too late"). Every STOP_LOSS / RUG_DETECTED exit is followed
 * for the same 30 minutes: did the coin really die (a good exit), or come back above our entry (a false alarm /
 * a stop that sold the bottom)? Stops also record how far past the stop the fill landed (overshoot = late exit or
 * bad fill). The three rug-exit shapes that read the chart (cascade / one wallet / crash) are loosened a little on
 * their own when they keep firing on coins that recover, and tightened when every one of them was a real rug.
 */
export type LossExitKind =
  | 'stop_soft' | 'stop_hard' | 'stop_disaster' | 'stop_early'
  | 'rug_cascade' | 'rug_solo' | 'rug_crash' | 'rug_holders' | 'rug_insiders' | 'rug_whale' | 'rug_dev' | 'rug_bundlers' | 'rug_top10' | 'rug_other';

export const LOSS_KIND_LABEL: Record<LossExitKind, string> = {
  stop_soft: 'stop loss', stop_hard: 'hard stop', stop_disaster: 'disaster stop (inside the 5-min hold)', stop_early: 'early risk exit',
  rug_cascade: 'rug exit: sell cascade', rug_solo: 'rug exit: one wallet dumped', rug_crash: 'rug exit: crash', rug_holders: 'rug exit: top holders sold',
  rug_insiders: 'rug exit: insiders dumped', rug_whale: 'rug exit: whale sell', rug_dev: 'rug exit: dev sold', rug_bundlers: 'rug exit: bundlers dumped',
  rug_top10: 'rug exit: top-10 jump', rug_other: 'rug exit: other',
};

/** The config path of the chart-reading rug exits the tuner may adjust, with its allowed range. */
export const RUG_TUNE: Partial<Record<LossExitKind, { path: string; min: number; max: number }>> = {
  rug_cascade: { path: 'antiRug.rugGuard.cascade.dropPct', min: 15, max: 35 },
  rug_solo: { path: 'antiRug.rugGuard.cascade.soloDropPct', min: 20, max: 40 },
  rug_crash: { path: 'antiRug.rugGuard.cascade.crashDropPct', min: 25, max: 45 },
};

/** Pure: which kind of loss exit, from the exit reason + the sell's text. null = not a loss exit we follow. */
export function lossExitKind(exitReason: string, text: string): { kind: LossExitKind; stopPct: number | null } | null {
  const r = text.toLowerCase();
  const num = (re: RegExp) => {
    const m = r.match(re);
    return m ? Number(m[1]) : null;
  };
  if (exitReason === 'STOP_LOSS') {
    if (r.includes('disaster')) return { kind: 'stop_disaster', stopPct: num(/−(\d+(?:\.\d+)?)% disaster/) };
    if (r.includes('hard limit')) return { kind: 'stop_hard', stopPct: num(/hard limit −(\d+(?:\.\d+)?)%/) };
    if (r.includes('early exit')) return { kind: 'stop_early', stopPct: null };
    return { kind: 'stop_soft', stopPct: num(/−(\d+(?:\.\d+)?)% stop/) };
  }
  if (exitReason !== 'RUG_DETECTED') return null;
  const kind: LossExitKind = r.includes('sell cascade') ? 'rug_cascade'
    : r.includes('one wallet dumped') ? 'rug_solo'
    : r.startsWith('crash') ? 'rug_crash'
    : r.includes('top holder') ? 'rug_holders'
    : r.includes('insider') ? 'rug_insiders'
    : r.includes('whale') ? 'rug_whale'
    : r.includes('dev sold') || r.includes('dev ') ? 'rug_dev'
    : r.includes('bundlers') ? 'rug_bundlers'
    : r.includes('top-10') ? 'rug_top10'
    : 'rug_other';
  return { kind, stopPct: null };
}

export interface LossExitAfter {
  id: string;
  strategy: string;
  kind: LossExitKind;
  closedAtMs: number;
  /** Exit price ÷ entry price. */
  exitX: number;
  pnlPct: number;
  stopPct: number | null;
  maxAfterX: number;
  minAfterX: number;
  endX: number;
  trades: number;
}

export interface LossVerdict {
  kind: LossExitKind;
  label: string;
  n: number;
  avgPnlPct: number;
  /** % that came back above our entry (+5%) within 30 min — holding would have made money. */
  backAbovePct: number;
  /** % that kept collapsing (ended ≤ 0.6× our exit) — the exit saved money. */
  diedPct: number;
  /** Stops: how far past the stop the realised loss landed, on average (pts). */
  overshootPts: number | null;
  verdict: 'good' | 'false_alarm' | 'late' | 'mixed';
  why: string;
}

/** Pure: per kind of loss exit, was it right? */
export function judgeLossExits(rows: readonly LossExitAfter[], c: { minExits: number; falseAlarmPct: number; maxDiedPct: number; lateOvershootPts: number }): LossVerdict[] {
  const groups = new Map<LossExitKind, LossExitAfter[]>();
  for (const r of rows) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  const out: LossVerdict[] = [];
  for (const [kind, g] of groups) {
    const pct = (k: number) => Math.round((k / g.length) * 100);
    const backAbovePct = pct(g.filter((r) => r.maxAfterX * r.exitX >= 1.05).length);
    const diedPct = pct(g.filter((r) => r.endX <= 0.6).length);
    const avgPnlPct = Math.round((g.reduce((t, r) => t + r.pnlPct, 0) / g.length) * 10) / 10;
    const withStop = g.filter((r) => r.stopPct !== null);
    const overshootPts = withStop.length ? Math.round((withStop.reduce((t, r) => t + (-r.pnlPct - r.stopPct!), 0) / withStop.length) * 10) / 10 : null;
    let verdict: LossVerdict['verdict'] = 'mixed';
    let why = `${g.length} exits: ${backAbovePct}% came back above our entry within 30 min, ${diedPct}% kept collapsing`;
    if (g.length >= c.minExits && backAbovePct >= c.falseAlarmPct && diedPct <= c.maxDiedPct) {
      verdict = 'false_alarm';
      why = `${backAbovePct}% of ${g.length} exits came back above our entry within 30 min and only ${diedPct}% really died — this exit fires too easily`;
    } else if (g.length >= c.minExits && overshootPts !== null && overshootPts >= c.lateOvershootPts) {
      verdict = 'late';
      why = `losses landed ${overshootPts} pts past the stop on average — the exit (or the fill) comes too late`;
    } else if (g.length >= c.minExits && diedPct >= 100 - c.falseAlarmPct && backAbovePct <= 10) {
      verdict = 'good';
      why = `${diedPct}% of ${g.length} exits kept collapsing after we sold — this exit saves money`;
    }
    out.push({ kind, label: LOSS_KIND_LABEL[kind], n: g.length, avgPnlPct, backAbovePct, diedPct, overshootPts, verdict, why });
  }
  return out.sort((a, b) => b.n - a.n);
}

export interface TimerVerdict {
  strategy: string;
  timer: ExitTimer;
  n: number;
  ranPct: number;
  medianEndX: number;
  avgMaxAfterX: number;
  action: 'longer' | 'shorter' | 'keep';
  why: string;
}

/** Pure: the verdict per strategy × timer. */
export function judgeTimers(rows: readonly ExitAfter[], c: Pick<ExitTunerConfig, 'minExits' | 'ranAfterPct' | 'deadAfterPct'>): TimerVerdict[] {
  const groups = new Map<string, ExitAfter[]>();
  for (const r of rows) groups.set(`${r.strategy}|${r.timer}`, [...(groups.get(`${r.strategy}|${r.timer}`) ?? []), r]);
  const out: TimerVerdict[] = [];
  for (const [k, g] of groups) {
    const [strategy, timer] = k.split('|') as [string, ExitTimer];
    const ran = g.filter((r) => r.maxAfterX >= 1.25).length;
    const ranPct = Math.round((ran / g.length) * 100);
    const ends = g.map((r) => r.endX).sort((a, b) => a - b);
    const medianEndX = ends[Math.floor(ends.length / 2)]!;
    const avgMaxAfterX = Math.round((g.reduce((s, r) => s + r.maxAfterX, 0) / g.length) * 100) / 100;
    let action: TimerVerdict['action'] = 'keep';
    let why = `${g.length} exits: ${ranPct}% ran +25% after we sold, typical coin ended at ${medianEndX}x of our exit`;
    if (g.length >= c.minExits && ranPct >= c.ranAfterPct) {
      action = 'longer';
      why = `${ranPct}% of ${g.length} exits by the ${TIMER_LABEL[timer]} ran +25% or more after we sold — waiting longer`;
    } else if (g.length >= c.minExits && ranPct <= c.deadAfterPct && medianEndX <= 0.95) {
      action = 'shorter';
      why = `only ${ranPct}% of ${g.length} exits ran after we sold and the typical coin fell to ${medianEndX}x — getting out sooner`;
    }
    out.push({ strategy, timer, n: g.length, ranPct, medianEndX, avgMaxAfterX, action, why });
  }
  return out.sort((a, b) => b.n - a.n);
}

export class ExitTuner {
  private timer: NodeJS.Timeout | null = null;
  private last: { at: string; verdicts: TimerVerdict[]; lossExits: LossVerdict[] } | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly trades: (mint: string) => readonly CrowdTrade[],
    private readonly cfg: () => ExitTunerConfig = () => getConfig().exitTuner ?? DEFAULT_CONFIG.exitTuner,
  ) {}

  start(): void {
    const tick = () => void this.run();
    this.timer = setInterval(tick, 5 * 60_000);
    this.timer.unref?.();
    setTimeout(tick, 2 * 60_000).unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): { at: string; verdicts: TimerVerdict[]; lossExits: LossVerdict[] } | null {
    return this.last;
  }

  async lossResults(): Promise<LossExitAfter[]> {
    return (await this.redis.lrange(K.loss, 0, 2999)).flatMap((x) => {
      try {
        return [JSON.parse(x) as LossExitAfter];
      } catch {
        return [];
      }
    });
  }

  /** Follow stop-loss / rug exits closed `watchMin`…`watchMin + 25` minutes ago, judge them, re-tune chart rug exits. */
  private async lossExits(now: number, c: ExitTunerConfig): Promise<LossVerdict[]> {
    const lc = c.lossExits ?? DEFAULT_CONFIG.exitTuner.lossExits;
    if (!lc.enabled) return [];
    const watchMs = c.watchMin * 60_000;
    const ps = await prisma.position.findMany({
      where: { mode: 'PAPER', status: 'CLOSED', exitReason: { in: ['STOP_LOSS', 'RUG_DETECTED'] }, closedAt: { gte: new Date(now - watchMs - 25 * 60_000), lte: new Date(now - watchMs) } },
      select: { id: true, mint: true, strategy: true, exitReason: true, entryPriceSol: true, sizeSol: true, realizedPnlSol: true, closedAt: true, trades: { where: { side: 'SELL' }, orderBy: { createdAt: 'desc' }, take: 1, select: { reason: true, priceSol: true } } },
      take: 300,
    });
    for (const p of ps) {
      if (await this.redis.sismember(K.done, `L${p.id}`)) continue;
      await this.redis.sadd(K.done, `L${p.id}`);
      const sell = p.trades[0];
      const k = sell && p.exitReason ? lossExitKind(p.exitReason, sell.reason) : null;
      if (!sell || !k || !p.closedAt || !(p.entryPriceSol > 0)) continue;
      const a = afterExit(this.trades(p.mint), p.closedAt.getTime(), sell.priceSol, watchMs);
      // No trades at all after a rug exit = the coin died: count it (it's the most common "good" outcome).
      const after = a ?? { maxAfterX: 1, minAfterX: 1, endX: k.kind.startsWith('rug') ? 0 : 1, trades: 0 };
      if (!a && !k.kind.startsWith('rug')) continue;
      const row: LossExitAfter = {
        id: p.id, strategy: p.strategy, kind: k.kind, closedAtMs: p.closedAt.getTime(), exitX: Math.round((sell.priceSol / p.entryPriceSol) * 1000) / 1000,
        pnlPct: p.sizeSol > 0 ? Math.round((p.realizedPnlSol / p.sizeSol) * 1000) / 10 : 0, stopPct: k.stopPct, ...after,
      };
      await this.redis.multi().lpush(K.loss, JSON.stringify(row)).ltrim(K.loss, 0, 2999).exec();
    }
    const rows = (await this.lossResults()).filter((r) => now - r.closedAtMs <= 7 * 86_400_000);
    const verdicts = judgeLossExits(rows, lc);
    if (!lc.tuneRugExits) return verdicts;
    for (const v of verdicts) {
      const t = RUG_TUNE[v.kind];
      if (!t || (v.verdict !== 'false_alarm' && v.verdict !== 'good')) continue;
      const key = `loss:${v.kind}`;
      const lastChange = Number((await this.redis.get(K.changed(key))) ?? 0);
      if (now - lastChange < c.minHoursBetween * 3_600_000) continue;
      if (rows.filter((r) => r.kind === v.kind && r.closedAtMs > lastChange).length < lc.minExits) continue;
      const cur = Number(t.path.split('.').reduce<unknown>((o, x) => (o as Record<string, unknown> | undefined)?.[x], getConfig()));
      if (!(cur > 0)) continue;
      // False alarms → needs a deeper drop before it calls a rug; every one a real rug → may call it a bit sooner.
      const next = Math.min(t.max, Math.max(t.min, cur + (v.verdict === 'false_alarm' ? lc.step : -Math.round(lc.step / 2))));
      if (next === cur) continue;
      if (sniperOn()) continue; // v11.7: watch-only in sniper mode
      const r = await applyEdit(t.path, next, 'exit-tuner', v.why);
      if (r.ok) {
        await this.redis.set(K.changed(key), String(now), 'EX', 30 * 86_400);
        log.info({ kind: v.kind, from: cur, to: next }, '🧯 rug exit re-tuned from what coins did after we sold');
      }
    }
    return verdicts;
  }

  async results(): Promise<ExitAfter[]> {
    return (await this.redis.lrange(K.res, 0, 1999)).flatMap((x) => {
      try {
        return [JSON.parse(x) as ExitAfter];
      } catch {
        return [];
      }
    });
  }

  /** Record the after-exit picture of trades closed `watchMin`…`watchMin + 25` minutes ago, then judge the timers. */
  async run(now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled) return;
    try {
      const watchMs = c.watchMin * 60_000;
      const ps = await prisma.position.findMany({
        where: { mode: 'PAPER', status: 'CLOSED', exitReason: { in: ['STALE', 'TAKE_PROFIT'] }, closedAt: { gte: new Date(now - watchMs - 25 * 60_000), lte: new Date(now - watchMs) } },
        select: { id: true, mint: true, strategy: true, sizeSol: true, realizedPnlSol: true, closedAt: true, trades: { where: { side: 'SELL' }, orderBy: { createdAt: 'desc' }, take: 1, select: { reason: true, priceSol: true } } },
        take: 200,
      });
      for (const p of ps) {
        if (await this.redis.sismember(K.done, p.id)) continue;
        await this.redis.sadd(K.done, p.id);
        const sell = p.trades[0];
        const timer = sell ? timerOf(sell.reason) : null;
        if (!sell || !timer || !p.closedAt) continue;
        const a = afterExit(this.trades(p.mint), p.closedAt.getTime(), sell.priceSol, watchMs);
        if (!a) continue;
        const row: ExitAfter = { id: p.id, strategy: p.strategy, timer, closedAtMs: p.closedAt.getTime(), exitPriceSol: sell.priceSol, pnlPct: p.sizeSol > 0 ? Math.round((p.realizedPnlSol / p.sizeSol) * 1000) / 10 : 0, ...a };
        await this.redis.multi().lpush(K.res, JSON.stringify(row)).ltrim(K.res, 0, 1999).exec();
      }
      await this.redis.expire(K.done, 3 * 86_400);
      const rows = (await this.results()).filter((r) => now - r.closedAtMs <= 7 * 86_400_000);
      const verdicts = judgeTimers(rows, c);
      const lossExits = await this.lossExits(now, c).catch((err: Error) => {
        log.warn({ err: err.message }, 'loss exit review failed');
        return this.last?.lossExits ?? [];
      });
      this.last = { at: new Date(now).toISOString(), verdicts, lossExits };
      for (const v of verdicts) {
        if (v.action === 'keep') continue;
        const key = `${v.strategy}:${v.timer}`;
        const lastChange = Number((await this.redis.get(K.changed(key))) ?? 0);
        if (now - lastChange < c.minHoursBetween * 3_600_000) continue;
        // Only exits since the last change count as evidence for the next one.
        const since = rows.filter((r) => r.strategy === v.strategy && r.timer === v.timer && r.closedAtMs > lastChange).length;
        if (since < c.minExits) continue;
        const path = `${TIMER_PATH[v.timer]}.${v.strategy}`;
        const cur = Number(path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], getConfig()));
        const def = Number(path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], DEFAULT_CONFIG));
        if (!(cur > 0) || !(def > 0)) continue;
        const next = Math.round(Math.min(def * c.maxFactor, Math.max(def * c.minFactor, cur * (v.action === 'longer' ? 1.25 : 0.85))) * 10) / 10;
        if (next === cur) continue;
        if (sniperOn()) continue; // v11.7: watch-only in sniper mode
        const r = await applyEdit(path, next, 'exit-tuner', v.why);
        if (r.ok) {
          await this.redis.set(K.changed(key), String(now), 'EX', 30 * 86_400);
          log.info({ strategy: v.strategy, timer: v.timer, from: cur, to: next }, '⏱️ exit timer tuned from what coins did after we sold');
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'exit tuner run failed');
    }
  }
}
