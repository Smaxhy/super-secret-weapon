/**
 * Forex calendar + market clock (v12.4). News: ForexFactory's free weekly JSON (high / medium / low impact releases,
 * central-bank decisions, bank holidays per currency), fetched at most hourly, Redis `fx:cal`. Clock: forex trades from
 * Sunday 17:00 to Friday 17:00 New York time; sessions in UTC. Used by the auto-bot: no new trades 30 min either side
 * of high-impact news for a pair's currencies, none on a currency's bank holiday, none in the last 2 h before the
 * weekly close, and everything closed 30 min before it (weekend gaps skip stops).
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('forex-calendar');
const KEY = 'fx:cal';
/** v13: every high-impact release + central-bank speech seen so far (≤ 400 days) — the "after big moves" study uses it */
const HIST_KEY = 'fx:cal:hist';
const URLS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];

export interface CalEvent {
  t: number;
  ccy: string;
  title: string;
  impact: 'High' | 'Medium' | 'Low' | 'Holiday' | 'Non-Economic';
  forecast: string;
  previous: string;
}

/** Parse ForexFactory JSON. Pure. */
export function parseCalendar(json: unknown): CalEvent[] {
  if (!Array.isArray(json)) return [];
  const out: CalEvent[] = [];
  for (const e of json as Array<Record<string, unknown>>) {
    const t = Date.parse(String(e.date ?? ''));
    const ccy = String(e.country ?? '').toUpperCase();
    if (!Number.isFinite(t) || !/^[A-Z]{3}$/.test(ccy)) continue;
    const imp = String(e.impact ?? '');
    const impact = (['High', 'Medium', 'Low', 'Holiday', 'Non-Economic'] as const).find((x) => x === imp) ?? 'Low';
    out.push({ t, ccy, title: String(e.title ?? ''), impact, forecast: String(e.forecast ?? ''), previous: String(e.previous ?? '') });
  }
  return out.sort((a, b) => a.t - b.t);
}

const currenciesOf = (pair: string) => (pair.startsWith('XA') ? ['USD'] : [pair.slice(0, 3), pair.slice(3, 6)]);

/** Why a NEW trade on `pair` must wait right now (null = fine). Pure. */
export function newsBlock(pair: string, now: number, events: readonly CalEvent[], windowMin = 30): string | null {
  const ccys = currenciesOf(pair);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  for (const e of events) {
    if (!ccys.includes(e.ccy)) continue;
    const speech = e.impact === 'Medium' && /speaks|testif|press conference|remarks|statement/i.test(e.title);
    if ((e.impact === 'High' || speech) && Math.abs(e.t - now) <= windowMin * 60_000) return `${e.ccy} ${speech ? 'speech' : 'news'}: ${e.title}`;
    if (e.impact === 'Holiday' && day(e.t) === day(now)) return `${e.ccy} bank holiday: ${e.title}`;
  }
  return null;
}

/** New York weekday (0 = Sun) + minutes since NY midnight. */
function nyClock(t: number): { dow: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '0';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow, min: Number(get('hour')) * 60 + Number(get('minute')) };
}

export interface MarketClock {
  open: boolean;
  /** minutes until the weekly close (open) or the weekly open (closed) */
  minutesToChange: number;
  /** no new auto-bot trades (last 2 h of the week) */
  noNewTrades: boolean;
  /** close all auto-bot trades now (last 30 min of the week) */
  flattenNow: boolean;
  sessions: string[];
  /** v14: minutes since the weekly open (Sunday 17:00 New York); −1 while closed */
  sinceOpenMin: number;
  /** v14: daily rollover (20:45–23:15 UTC): spreads widen, no new auto-bot trades */
  rollover: boolean;
}

/** Pure: the forex market clock at `t`. */
export function marketClock(t: number): MarketClock {
  const { dow, min } = nyClock(t);
  const CLOSE = 17 * 60;
  const open = !(dow === 6 || (dow === 5 && min >= CLOSE) || (dow === 0 && min < CLOSE));
  // minutes from now to Friday 17:00 NY (open) or Sunday 17:00 NY (closed)
  const minsToDow = (targetDow: number) => ((targetDow - dow + 7) % 7) * 1440 + CLOSE - min;
  let toChange = open ? minsToDow(5) : minsToDow(0);
  if (toChange < 0) toChange += 7 * 1440;
  const h = new Date(t).getUTCHours();
  const sessions = [h >= 21 || h < 6 ? 'Sydney' : '', h < 9 ? 'Tokyo' : '', h >= 7 && h < 16 ? 'London' : '', h >= 12 && h < 21 ? 'New York' : ''].filter(Boolean);
  const sinceOpenMin = open ? dow * 1440 + min - CLOSE : -1;
  const um = new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes();
  return { open, minutesToChange: toChange, noNewTrades: !open || toChange <= 120, flattenNow: open && toChange <= 30, sessions: open ? sessions : [], sinceOpenMin, rollover: um >= 20 * 60 + 45 && um < 23 * 60 + 15 };
}

/** Merge new events into the kept history (high impact + speeches, newest 400 days, deduped). Pure. */
export function mergeHistory(hist: readonly CalEvent[], fresh: readonly CalEvent[], now: number): CalEvent[] {
  const keep = (e: CalEvent) => e.impact === 'High' || (e.impact === 'Medium' && /speaks|testif|press conference|remarks|statement/i.test(e.title));
  const m = new Map<string, CalEvent>();
  for (const e of [...hist, ...fresh]) if (keep(e) && e.t >= now - 400 * 86_400_000 && e.t <= now + 8 * 86_400_000) m.set(`${e.t}:${e.ccy}:${e.title}`, e);
  return [...m.values()].sort((a, b) => a.t - b.t).slice(-4_000);
}

export class ForexCalendar {
  private events: CalEvent[] = [];
  private hist: CalEvent[] = [];
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly redis: Redis) {}

  async start(): Promise<void> {
    const raw = await this.redis.get(KEY).catch(() => null);
    if (raw) {
      try {
        const j = JSON.parse(raw) as { at: number; events: CalEvent[] };
        this.events = j.events;
        this.fetchedAt = j.at;
      } catch {
        // refetch
      }
    }
    const h = await this.redis.get(HIST_KEY).catch(() => null);
    if (h) {
      try {
        this.hist = JSON.parse(h) as CalEvent[];
      } catch {
        this.hist = [];
      }
    }
    if (this.events.length && !this.hist.length) this.hist = mergeHistory([], this.events, Date.now());
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60 * 60_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    if (Date.now() - this.fetchedAt < 55 * 60_000 && this.events.length) return;
    const all: CalEvent[] = [];
    for (const url of URLS) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(15_000) });
        if (res.ok) all.push(...parseCalendar(await res.json()));
      } catch (err) {
        log.warn({ url, err: (err as Error).message }, 'calendar fetch failed');
      }
    }
    if (!all.length) return;
    const seen = new Set<string>();
    this.events = all.filter((e) => {
      const k = `${e.t}:${e.ccy}:${e.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.fetchedAt = Date.now();
    await this.redis.set(KEY, JSON.stringify({ at: this.fetchedAt, events: this.events })).catch(() => undefined);
    this.hist = mergeHistory(this.hist, this.events, this.fetchedAt);
    await this.redis.set(HIST_KEY, JSON.stringify(this.hist)).catch(() => undefined);
  }

  /** Released events kept so far (for the "after big moves" study). */
  history(now = Date.now()): CalEvent[] {
    return this.hist.filter((e) => e.t <= now);
  }

  get(): { at: number; events: CalEvent[] } {
    return { at: this.fetchedAt, events: this.events };
  }
  blockFor(pair: string, now = Date.now()): string | null {
    return newsBlock(pair, now, this.events);
  }
}
