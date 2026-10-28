/**
 * v27.52 (owner: "copy his trades immediately, or even 1–2 minutes later" — his MNQ long at 29,194.75 off his 29,182.25
 * level ran +$3,973 while the bot only looked at 15-minute candles that arrive ~10 min late). Every `everyMs` the
 * watcher reads the LIVE 1-minute candles of each market with posted levels from Hyperliquid's builder market for it
 * (moved onto the futures price by the measured gap, `Practice.hlGap`) and runs the same absorption-at-his-level test
 * (`postedLevelSignal`) on the newest finished minute → the trade opens about a minute after the touch. Markets without
 * a live 1-minute source (currency pairs, coins) keep the 15-minute pass in fast.ts.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { clockFor } from './calendar';
import { DISCORD_COPY, POSTED_LEVELS, levelSets, levelStrategy, loadLevels, type LevelSet } from './discord';
import { hlCandles, loadHlFutures } from './hyperliquid';
import { walkTrade, type Practice } from './practice';
import { postedLevelSignal } from './strategies';
import { buildCtx } from './ta';
import { instrument, isFutures, type Bar } from './types';
import { feePxOf } from './venue-fees';

const log = moduleLogger('level-watch');

export const LEVEL_WATCH = {
  everyMs: 20_000,
  /** minutes of 1-minute candles read each time (indicators need a warm-up) */
  minutes: 360,
  /** the newest finished minute must be this fresh, else the feed is behind and nothing is taken */
  maxLagMs: 3 * 60_000,
  /** stop floor, % of the price: a 1-minute stop is a few points, and the venue fee (a share of the position) would eat it */
  minStopPct: 0.08,
  /** v27.72: a level trade whose open + close venue fee is more than this share of its stop distance is skipped (Oct 28:
   * a gold level long with a $3.46 stop paid a ~$4 fee a unit — it lost ~$90 on a 3-dollar wiggle) */
  maxFeeShare: 0.25,
};

/** Open + close venue fee of a trade, in price units (2 × fee% a side × entry). Pure. */
export function feePx(pair: string, entry: number): number {
  const inst = instrument(pair);
  return inst ? feePxOf(inst, entry) : 0;
}

/** Why a level trade isn't worth taking after fees, or null. Pure. */
export function feeTooBig(pair: string, entry: number, stop: number): string | null {
  const fee = feePx(pair, entry);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || fee <= LEVEL_WATCH.maxFeeShare * risk) return null;
  return `the venue fee (${+fee.toPrecision(3)} a unit round trip) is ${Math.round((fee / risk) * 100)}% of its ${+risk.toPrecision(3)} stop — not worth it after fees`;
}

export interface LevelTrade {
  pair: string;
  side: 1 | -1;
  stop: number;
  target: number | null;
  /** the signal candle's open time (one trade per candle) */
  barT: number;
  /** v27.72: the signal candle's close (the fee check) */
  entry: number;
  source: string;
  /** v27.74: which rule fired, for the bot log */
  why?: string;
}

/** Open trades at posted levels: one per candle (Redis NX — a candle seen twice never trades twice), one open at a time
 * per market and source, sized and stopped like his copies (2% / the $ cap), the profit lock trailing it. */
export async function takeLevelTrades(redis: Redis, practice: Practice, acct: 'bot' | 'cbot', list: readonly LevelTrade[], logBot: (lines: string[]) => void): Promise<void> {
  if (!list.length) return;
  const held = await practice.heldRefs(acct).catch(() => [] as string[]);
  for (const x of list) {
    const strategy = levelStrategy(x.source);
    if (held.some((r) => r.startsWith(`${strategy}:signal:${x.pair}:`))) continue;
    const ref = `${strategy}:signal:${x.pair}:${x.barT}`;
    const first = await redis.set(`fx:discord:lvdone:${ref}`, '1', 'EX', 2 * 86_400, 'NX').catch(() => null);
    if (first !== 'OK') continue;
    const tooBig = feeTooBig(x.pair, x.entry, x.stop);
    if (tooBig) {
      logBot([`Kojiro level on ${x.pair}: not taken — ${tooBig}`]);
      continue;
    }
    const r = await practice
      .copyOpen({ pair: x.pair, side: x.side, stopNamed: null, hisPx: null, strategy, ref, riskPct: DISCORD_COPY.riskPct, leverage: DISCORD_COPY.leverage, profitLock: true, stop: x.stop, target: x.target }, acct)
      .catch((err: Error) => ({ ok: false as const, error: err.message, entry: undefined, stop: undefined, riskUsd: undefined }));
    if (r.ok) held.push(ref);
    logBot([r.ok ? `Kojiro level: ${x.side === 1 ? 'bought' : 'sold'} ${x.pair} at ${r.entry} — ${x.why ?? 'absorbed at his level'}; stop ${r.stop}${x.target !== null ? `, target ${x.target}` : ''}, risking $${r.riskUsd}, tight trailing stop once in profit` : `Kojiro level on ${x.pair}: not taken — ${r.error}`]);
  }
}

/** v27.77 (owner: "keep all Kojiro calls in labs for now — they work for him, apparently not for us"): with level trades
 * off, every level setup the watcher sees is RECORDED instead (one per candle), then graded on the live minutes after it
 * like the account would have run it (stop first, the profit lock with fees, target) — R after the venue fee. */
export const LEVEL_LAB = { key: 'fx:discord:lvlab', max: 300, maxOpenMs: 24 * 3_600_000 };

export interface LabLevelTrade {
  ref: string;
  pair: string;
  side: 1 | -1;
  entry: number;
  stop: number;
  target: number | null;
  /** entry time (the signal minute's close) */
  t: number;
  why: string;
  done?: { at: number; exit: number; reason: 'stop' | 'target' | 'expired'; locked: boolean; pts: number; r: number };
}

export async function loadLevelLab(redis: Redis): Promise<LabLevelTrade[]> {
  const raw = await redis.get(LEVEL_LAB.key).catch(() => null);
  try {
    return raw ? (JSON.parse(raw) as LabLevelTrade[]) : [];
  } catch {
    return [];
  }
}

/** Grade the open lab rows of one market on its minutes (finished, on the futures price). Mutates; true when any changed. Pure. */
export function gradeLevelLab(rows: LabLevelTrade[], pair: string, bars: readonly Bar[], now: number): boolean {
  const inst = instrument(pair);
  if (!inst) return false;
  let changed = false;
  for (const x of rows) {
    if (x.done || x.pair !== pair) continue;
    const after = bars.filter((b) => b.t >= x.t);
    const fee = feePxOf(inst, x.entry);
    const w = walkTrade(x.side, x.entry, x.stop, x.target, after, (inst.spreadPips * inst.pip) / 2, fee);
    const risk = Math.abs(x.entry - x.stop);
    const close = (exit: number, reason: 'stop' | 'target' | 'expired', at: number) => {
      const pts = x.side * (exit - x.entry);
      x.done = { at, exit, reason, locked: w.locked, pts: Math.round(pts * 100) / 100, r: risk > 0 ? Math.round(((pts - fee) / risk) * 100) / 100 : 0 };
      changed = true;
    };
    if (w.reason) close(w.exit, w.reason, after[w.exitIdx]!.t + 60_000);
    else if (now - x.t > LEVEL_LAB.maxOpenMs && after.length) close(after[after.length - 1]!.c, 'expired', now);
  }
  return changed;
}

/** Totals of the lab: finished trades, wins, R after fees. Pure. */
export function levelLabSummary(rows: readonly LabLevelTrade[]): { n: number; done: number; wins: number; totalR: number; avgR: number | null; open: number; byWhy: Record<string, { n: number; totalR: number }> } {
  const done = rows.filter((x) => x.done);
  const totalR = Math.round(done.reduce((s, x) => s + x.done!.r, 0) * 100) / 100;
  const byWhy: Record<string, { n: number; totalR: number }> = {};
  for (const x of done) {
    const g = (byWhy[x.why] ??= { n: 0, totalR: 0 });
    g.n++;
    g.totalR = Math.round((g.totalR + x.done!.r) * 100) / 100;
  }
  return { n: rows.length, done: done.length, wins: done.filter((x) => x.done!.r > 0).length, totalR, avgR: done.length ? Math.round((totalR / done.length) * 100) / 100 : null, open: rows.length - done.length, byWhy };
}

/** Live 1-minute candles moved onto the futures price; only finished minutes. Pure. */
export function shiftedMinutes(live: readonly Bar[], gap: number, now: number): Bar[] {
  return live.filter((b) => b.t + 60_000 <= now).map((b) => ({ ...b, o: b.o + gap, h: b.h + gap, l: b.l + gap, c: b.c + gap }));
}

/** v27.69 (owner: "it legit had levels but the bot didn't take em — go in them at the exact time, pull yourself back to
 * learn from it"): the 1-minute candles since his post replayed with today's rules (bounce or break-and-retest at his
 * levels, his side); every trade the watcher would have opened — one at a time, the next only after the last closed —
 * is booked on the bot account as if taken at that minute's close. Returns the lines for the bot log. */
export async function replayMissedLevels(redis: Redis, practice: Pick<Practice, 'bookLevelTrade'>, pair: string, source: string, sets: readonly LevelSet[], fromT: number, bars: readonly Bar[], maxTrades = 3): Promise<string[]> {
  const ctx = buildCtx([...bars], 1, pair);
  const strategy = levelStrategy(source);
  const lines: string[] = [];
  let after = fromT;
  for (let i = 60; i < bars.length && lines.length < maxTrades; i++) {
    if (bars[i]!.t < after) continue;
    const minRisk = (bars[i]!.c * LEVEL_WATCH.minStopPct) / 100;
    let sig = null;
    for (const st of sets) if ((sig = postedLevelSignal(ctx, i, st.levels, st.t, st.side, st.dol, minRisk, st.all))) break;
    if (!sig || feeTooBig(pair, bars[i]!.c, sig.stop)) continue;
    const ref = `${strategy}:signal:${pair}:${bars[i]!.t}`;
    await redis.set(`fx:discord:lvdone:${ref}`, '1', 'EX', 2 * 86_400, 'NX').catch(() => null);
    const res = await practice.bookLevelTrade('bot', { pair, side: sig.side, entry: bars[i]!.c, stop: sig.stop, target: sig.target, openedAt: bars[i]!.t + 60_000, ref, strategy, riskPct: DISCORD_COPY.riskPct, leverage: DISCORD_COPY.leverage }, bars.slice(i + 1));
    lines.push(res.line);
    if (res.closedAt === null) break;
    after = res.closedAt;
  }
  return lines;
}

export class LevelWatch {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private noted = new Set<string>();

  constructor(
    private readonly redis: Redis,
    private readonly practice: Practice,
    private readonly logBot: (pair: string, lines: string[]) => void,
    private readonly candles: typeof hlCandles = hlCandles,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), LEVEL_WATCH.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy || !DISCORD_COPY.on) return;
    this.busy = true;
    try {
      const posted = await loadLevels(this.redis, now);
      const lab = POSTED_LEVELS.trade ? [] : await loadLevelLab(this.redis);
      let labChanged = false;
      const labHasOpen = lab.some((x) => !x.done);
      if (!Object.values(posted).some((x) => levelSets(x).length) && !labHasOpen) return;
      const hlMap = await loadHlFutures(this.redis);
      const pairs = new Set([...Object.keys(posted), ...lab.filter((x) => !x.done).map((x) => x.pair)]);
      for (const pair of pairs) {
        const lv = posted[pair];
        const coin = isFutures(pair) ? hlMap[pair] : undefined;
        const sets = lv ? levelSets(lv) : [];
        const grading = lab.some((x) => !x.done && x.pair === pair);
        if ((!sets.length && !grading) || !coin || !clockFor(pair, now).open) continue;
        const gap = this.practice.hlGap(pair, now);
        if (gap === null) {
          this.once(pair, `gap:${pair}`, `Kojiro levels on ${pair}: measuring the live-feed gap first (a minute or two) — until then the 15-minute pass watches his levels`);
          continue;
        }
        const live = await this.candles(coin, '1m', now - LEVEL_WATCH.minutes * 60_000, now).catch((err: Error) => {
          log.warn({ pair, err: err.message }, 'Hyperliquid 1-minute candles failed');
          return [] as Bar[];
        });
        const bars = shiftedMinutes(live, gap, now);
        const last = bars.length - 1;
        if (grading && gradeLevelLab(lab, pair, bars, now)) labChanged = true;
        if (!lv || !sets.length) continue;
        if (last < 60 || now - (bars[last]!.t + 60_000) > LEVEL_WATCH.maxLagMs) continue;
        const ctx = buildCtx(bars, 1, pair);
        const minRisk = (bars[last]!.c * LEVEL_WATCH.minStopPct) / 100;
        // plain levels (his bias + DOL), then his short / long lists (their side forced, targets = his other levels)
        let sig = null;
        for (const st of sets) if ((sig = postedLevelSignal(ctx, last, st.levels, st.t, st.side, st.dol, minRisk, st.all))) break;
        if (!sig) continue;
        if (!POSTED_LEVELS.trade) {
          // v27.77: lab only — record it once per candle, graded on the minutes after it
          const ref = `${levelStrategy(lv.source)}:lab:${pair}:${bars[last]!.t}`;
          if (lab.some((x) => x.ref === ref) || feeTooBig(pair, bars[last]!.c, sig.stop)) continue;
          lab.unshift({ ref, pair, side: sig.side, entry: bars[last]!.c, stop: sig.stop, target: sig.target, t: bars[last]!.t + 60_000, why: sig.note ?? 'level' });
          lab.splice(LEVEL_LAB.max);
          labChanged = true;
          this.logBot(pair, [`Kojiro level (LAB, not traded): would ${sig.side === 1 ? 'buy' : 'sell'} ${pair} at ${bars[last]!.c} — ${sig.note ?? 'at his level'}; stop ${+sig.stop.toFixed(2)}${sig.target !== null ? `, target ${sig.target}` : ''}`]);
          continue;
        }
        await takeLevelTrades(this.redis, this.practice, 'bot', [{ pair, side: sig.side, stop: sig.stop, target: sig.target, barT: bars[last]!.t, entry: bars[last]!.c, source: lv.source, why: sig.note }], (l) => this.logBot(pair, l));
      }
      if (labChanged) await this.redis.set(LEVEL_LAB.key, JSON.stringify(lab)).catch(() => undefined);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'level watch failed');
    } finally {
      this.busy = false;
    }
  }

  private once(pair: string, key: string, line: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.logBot(pair, [line]);
  }
}
