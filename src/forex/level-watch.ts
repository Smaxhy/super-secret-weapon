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
import { DISCORD_COPY, POSTED_LEVELS, levelSets, levelStrategy, loadLevels } from './discord';
import { hlCandles, loadHlFutures } from './hyperliquid';
import type { Practice } from './practice';
import { postedLevelSignal } from './strategies';
import { buildCtx } from './ta';
import { isFutures, type Bar } from './types';

const log = moduleLogger('level-watch');

export const LEVEL_WATCH = {
  everyMs: 20_000,
  /** minutes of 1-minute candles read each time (indicators need a warm-up) */
  minutes: 360,
  /** the newest finished minute must be this fresh, else the feed is behind and nothing is taken */
  maxLagMs: 3 * 60_000,
  /** stop floor, % of the price: a 1-minute stop is a few points, and the venue fee (a share of the position) would eat it */
  minStopPct: 0.08,
};

export interface LevelTrade {
  pair: string;
  side: 1 | -1;
  stop: number;
  target: number | null;
  /** the signal candle's open time (one trade per candle) */
  barT: number;
  source: string;
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
    const r = await practice
      .copyOpen({ pair: x.pair, side: x.side, stopNamed: null, hisPx: null, strategy, ref, riskPct: DISCORD_COPY.riskPct, leverage: DISCORD_COPY.leverage, profitLock: true, stop: x.stop, target: x.target }, acct)
      .catch((err: Error) => ({ ok: false as const, error: err.message, entry: undefined, stop: undefined, riskUsd: undefined }));
    if (r.ok) held.push(ref);
    logBot([r.ok ? `Kojiro level: ${x.side === 1 ? 'bought' : 'sold'} ${x.pair} at ${r.entry} — absorbed at his level; stop ${r.stop}${x.target !== null ? `, target ${x.target}` : ''}, risking $${r.riskUsd}, tight trailing stop once in profit` : `Kojiro level on ${x.pair}: not taken — ${r.error}`]);
  }
}

/** Live 1-minute candles moved onto the futures price; only finished minutes. Pure. */
export function shiftedMinutes(live: readonly Bar[], gap: number, now: number): Bar[] {
  return live.filter((b) => b.t + 60_000 <= now).map((b) => ({ ...b, o: b.o + gap, h: b.h + gap, l: b.l + gap, c: b.c + gap }));
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
    if (this.busy || !POSTED_LEVELS.trade || !DISCORD_COPY.on) return;
    this.busy = true;
    try {
      const posted = await loadLevels(this.redis, now);
      if (!Object.values(posted).some((x) => levelSets(x).length)) return;
      const hlMap = await loadHlFutures(this.redis);
      for (const [pair, lv] of Object.entries(posted)) {
        const coin = isFutures(pair) ? hlMap[pair] : undefined;
        const sets = levelSets(lv);
        if (!sets.length || !coin || !clockFor(pair, now).open) continue;
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
        if (last < 60 || now - (bars[last]!.t + 60_000) > LEVEL_WATCH.maxLagMs) continue;
        const ctx = buildCtx(bars, 1, pair);
        const minRisk = (bars[last]!.c * LEVEL_WATCH.minStopPct) / 100;
        // plain levels (his bias + DOL), then his short / long lists (their side forced, targets = his other levels)
        let sig = null;
        for (const st of sets) if ((sig = postedLevelSignal(ctx, last, st.levels, st.t, st.side, st.dol, minRisk, st.all))) break;
        if (!sig) continue;
        await takeLevelTrades(this.redis, this.practice, 'bot', [{ pair, side: sig.side, stop: sig.stop, target: sig.target, barT: bars[last]!.t, source: lv.source }], (l) => this.logBot(pair, l));
      }
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
