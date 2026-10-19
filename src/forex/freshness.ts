/**
 * v17 freshness: is a market's price data up to date? A series is measured in bars behind the newest bar that should
 * exist by now (weekend / holiday hours and the metals' daily halt don't count). A stale market gets no NEW bot trades
 * (open ones keep their stops and targets). Pure.
 */
import { marketClock, nyOffsetMs } from './calendar';
import type { Bar } from './types';

export const FRESH = {
  /** bars behind before a market counts as stale, per chart */
  lagStale: { '1m': 3, '15m': 2, '1h': 2, '4h': 2 } as Record<string, number>,
  /** the hourly market read (strength, mood, bigger charts) the fast charts lean on may be at most this old */
  bookMaxAgeMs: 150 * 60_000,
};

/** Open time of the newest bar that has closed by `now`. Pure. */
export const expectedLastBarT = (now: number, barMs: number) => Math.floor(now / barMs) * barMs - barMs;

/** Metals stop trading for the CME daily halt (17:00–18:00 New York): no bar is expected in that hour. */
const metalHalt = (t: number) => new Date(t + nyOffsetMs(t)).getUTCHours() === 17;

/**
 * How many bars that should exist by `now` are missing after the series' newest bar (closed hours skipped). Stops
 * counting at `cap` (a long outage needs no exact number). Pure.
 */
export function lagBars(id: string, lastT: number | null, now: number, barMs: number, cap = 200): number {
  const want = expectedLastBarT(now, barMs);
  if (lastT === null) return cap;
  let n = 0;
  const metal = id.startsWith('XA');
  for (let t = want; t > lastT && n < cap; t -= barMs) {
    if (!marketClock(t + barMs / 2).open) continue;
    if (metal && barMs <= 3_600_000 && metalHalt(t)) continue;
    n++;
  }
  return n;
}

export interface DataAge {
  id: string;
  tf: string;
  lastT: number | null;
  lagBars: number;
  status: 'fresh' | 'stale' | 'closed' | 'none';
}

/** The data age of one series. Pure. */
export function dataAgeOf(id: string, tf: string, bars: readonly Bar[], now: number, barMs: number): DataAge {
  const lastT = bars.length ? bars[bars.length - 1]!.t : null;
  const lag = lagBars(id, lastT, now, barMs);
  const status: DataAge['status'] = lastT === null ? 'none' : lag >= (FRESH.lagStale[tf] ?? 2) ? 'stale' : !marketClock(now).open ? 'closed' : 'fresh';
  return { id, tf, lastT, lagBars: lag, status };
}

const ageWords = (ms: number) => (ms >= 90 * 60_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`);

/** Why a market gets no new bot trades because of its data (null = fine). Pure. */
export function staleReason(a: DataAge | undefined, now: number): string | null {
  if (!a) return null;
  if (a.status === 'none') return `no ${a.tf} price data for ${a.id} yet: no new trades on it`;
  if (a.status !== 'stale') return null;
  return `${a.id} ${a.tf} prices are ${a.lastT === null ? 'missing' : `${ageWords(now - a.lastT)} old`} (${a.lagBars} candles behind — the price feed is lagging): no new trades on it`;
}
