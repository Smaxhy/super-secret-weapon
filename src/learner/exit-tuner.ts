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
import { DEFAULT_CONFIG } from '../config/default';
import { applyEdit } from '../config/apply-edit';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { CrowdTrade } from '../scanner/crowd-tracker';

const log = moduleLogger('exit-tuner');
const K = { done: 'exitafter:done', res: 'exitafter:res', changed: (k: string) => `exitafter:chg:${k}` };

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
  private last: { at: string; verdicts: TimerVerdict[] } | null = null;

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

  snapshot(): { at: string; verdicts: TimerVerdict[] } | null {
    return this.last;
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
      this.last = { at: new Date(now).toISOString(), verdicts };
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
