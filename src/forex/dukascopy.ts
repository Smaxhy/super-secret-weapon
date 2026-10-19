/**
 * v16 Dukascopy history (free bank-grade data, no account, open-source `dukascopy-node`): hourly bid + ask candles for
 * every traded market and strength cross, kept in Redis `fx:bars:dk:<id>` as [t, o, h, l, c, spreadPips] (mid prices,
 * spread at the bar's close). Used for (a) older history in front of Yahoo's 730 days, so the honest test has years
 * more data — FX only: gold / silver trade as futures on Yahoo and a spot history would jump at the seam — and (b) the
 * real spread per UTC hour (`spreads.ts`). First pull goes back `DK.historyDays` in 90-day pieces, then once a day the
 * newest days. v17: a store that doesn't reach back that far (e.g. only the lab's 3-day tail) gets its older part
 * back-filled until it does (or `backfillTries` back-fills in a row brought nothing older). Redis `fx:dk:meta` = what was
 * fetched.
 */
import type Redis from 'ioredis';
import { getHistoricalRates } from 'dukascopy-node';
import { moduleLogger } from '../lib/logger';
import { INSTRUMENTS, STRENGTH_PAIRS, instrument, type Bar } from './types';
import { profileFrom, setSpreadProfile } from './spreads';
import { marketClock } from './calendar';
import { feeds } from './feeds';

const log = moduleLogger('forex-dukascopy');
const DAY = 86_400_000;

export const DK = {
  /** how far back the first pull goes */
  historyDays: 1100,
  /** one request covers this many days */
  chunkDays: 90,
  /** spread profile from the newest N days */
  spreadDays: 120,
  /** re-check at most this often */
  refreshHours: 24,
  /** a seam jump bigger than this (fraction of price) → don't stitch the older history on */
  maxSeamGap: 0.004,
  /** pause between requests (be polite to the free service) */
  pauseMs: 300,
  /** one request may take at most this long (the library has no abort) */
  timeoutMs: 45_000,
  /** v17: stored history starting within this many days of `historyDays` back counts as reaching back */
  slackDays: 7,
  /** v17: back-fills in a row that brought nothing older before the store's start is trusted as where the data begins */
  backfillTries: 3,
};
const HOUR = 3_600_000;

export const dkKey = (id: string) => `fx:bars:dk:${id}`;
export const DK_META = 'fx:dk:meta';

export interface DkBar extends Bar {
  /** spread at the close, pips */
  s: number;
}

export interface DkMeta {
  at: number;
  /** v17: `full` = the older history needs no more back-fill; `tries` = back-fills in a row that brought nothing older */
  ids: Record<string, { bars: number; firstT: number | null; lastT: number | null; error: string | null; full?: boolean; tries?: number; note?: string }>;
}

type Fetch = (id: string, priceType: 'bid' | 'ask', from: Date, to: Date) => Promise<number[][]>;

/** v17: a request cut off by `withTimeout`; `what` says which one. */
export class DkTimeoutError extends Error {
  constructor(
    readonly what: string,
    ms: number,
  ) {
    super(`${what} timed out after ${Math.round(ms / 1000)} s`);
  }
}

/** Reject after `ms` (dukascopy-node has no abort option). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new DkTimeoutError(what, ms)), ms);
    }),
  ]);
}

/**
 * The real fetcher (dukascopy-node, h1 candles). v17: `volumes: true` + `ignoreFlats: true` — the library's flat-candle
 * filter reads the volume column, so with volumes off every weekend / holiday hour came back as a flat filler candle.
 */
const fetchDk: Fetch = (id, priceType, from, to) =>
  withTimeout(
    getHistoricalRates({ instrument: id.toLowerCase() as never, dates: { from, to }, timeframe: 'h1', priceType, format: 'array', volumes: true, ignoreFlats: true, batchSize: 5, pauseBetweenBatchesMs: 800, retryCount: 2, failAfterRetryCount: false }) as unknown as Promise<number[][]>,
    DK.timeoutMs,
    `dukascopy ${id} ${priceType}`,
  );

/** v17: 1-minute candles (backup live prices for the practice / bot account). */
export const fetchDkM1: Fetch = (id, priceType, from, to) =>
  withTimeout(
    getHistoricalRates({ instrument: id.toLowerCase() as never, dates: { from, to }, timeframe: 'm1', priceType, format: 'array', volumes: true, ignoreFlats: true, retryCount: 1, failAfterRetryCount: false }) as unknown as Promise<number[][]>,
    15_000,
    `dukascopy ${id} m1 ${priceType}`,
  );

export interface DkQuote {
  bid: number;
  ask: number;
  /** close time of the newest complete minute */
  priceT: number;
  /** complete 1-minute mid candles [t, h, l, c, o] */
  bars: Array<[number, number, number, number, number]>;
}
const dkQuoteCache = new Map<string, { at: number; q: DkQuote | null }>();

/**
 * v17: a live price from Dukascopy's 1-minute candles (the last 3 hours, complete minutes only) — currency pairs only
 * (its metals are spot, Yahoo's are futures). Cached 30 s per market; nothing while its breaker is open. Pure-ish.
 */
export async function dkQuote(id: string, now = Date.now(), fetcher: Fetch = fetchDkM1): Promise<DkQuote | null> {
  if (id.startsWith('XA')) return null;
  const c = dkQuoteCache.get(id);
  if (c && now - c.at < 30_000) return c.q;
  if (!feeds.allow('dukascopy')) return c?.q ?? null;
  let q: DkQuote | null = null;
  try {
    const from = new Date(now - 3 * HOUR);
    const [bid, ask] = [await fetcher(id, 'bid', from, new Date(now)), await fetcher(id, 'ask', from, new Date(now))];
    const askBy = new Map(ask.map((r) => [r[0]!, r]));
    const bars: DkQuote['bars'] = [];
    let last: { b: number; a: number; t: number } | null = null;
    for (const b of bid) {
      const a = askBy.get(b[0]!);
      if (!a || b[0]! + 60_000 > now || b[5] === 0 || a[5] === 0) continue;
      bars.push([b[0]!, (b[2]! + a[2]!) / 2, (b[3]! + a[3]!) / 2, (b[4]! + a[4]!) / 2, (b[1]! + a[1]!) / 2]);
      last = { b: b[4]!, a: a[4]!, t: b[0]! + 60_000 };
    }
    if (last && last.a >= last.b && last.b > 0) {
      q = { bid: last.b, ask: last.a, priceT: last.t, bars: bars.slice(-180) };
      feeds.ok('dk-quotes', { items: bars.length, asOf: last.t });
    } else feeds.fail('dk-quotes', `no complete minutes for ${id}`);
  } catch (err) {
    feeds.fail('dk-quotes', err);
  }
  dkQuoteCache.set(id, { at: now, q });
  return q;
}

/** A real trading hour: not a weekend / holiday filler and not still forming. Pure. */
export function liveHour(t: number, now: number | null, barMs = HOUR): boolean {
  if (now !== null && t + barMs > now) return false;
  return marketClock(t + barMs / 2).open;
}
const flatRow = (r: readonly number[]) => r[1] === r[2] && r[2] === r[3] && r[3] === r[4];

const pipOf = (id: string) => instrument(id)?.pip ?? (id.includes('JPY') ? 0.01 : 0.0001);

/**
 * Bid + ask candles → mid bars with the close spread in pips. Dropped (v17): bars missing on either side, bars with no
 * volume on either side, bars flat on both sides (filler), weekend / holiday hours and the still-forming bar (`now`).
 * Pure.
 */
export function midBars(id: string, bid: ReadonlyArray<readonly number[]>, ask: ReadonlyArray<readonly number[]>, now: number | null = null): DkBar[] {
  const pip = pipOf(id);
  const askBy = new Map(ask.map((r) => [r[0]!, r]));
  const out: DkBar[] = [];
  for (const b of bid) {
    const a = askBy.get(b[0]!);
    if (!a) continue;
    if (b[5] === 0 || a[5] === 0) continue;
    if (flatRow(b) && flatRow(a)) continue;
    if (!liveHour(b[0]!, now)) continue;
    const [t, bo, bh, bl, bc] = b as [number, number, number, number, number];
    const [, ao, ah, al, ac] = a as [number, number, number, number, number];
    if (![bo, bh, bl, bc, ao, ah, al, ac].every((x) => Number.isFinite(x) && x > 0)) continue;
    out.push({ t, o: (bo + ao) / 2, h: (bh + ah) / 2, l: (bl + al) / 2, c: (bc + ac) / 2, s: Math.max(0, (ac - bc) / pip) });
  }
  return out.sort((x, y) => x.t - y.t);
}

const px7 = (x: number) => Number(x.toPrecision(7));

/** Stored rows without the filler / weekend bars older versions saved (pure). */
export function cleanDk(bars: readonly DkBar[]): DkBar[] {
  return bars.filter((b) => !(b.o === b.h && b.h === b.l && b.l === b.c) && liveHour(b.t, null));
}

/**
 * Stored bars; v17: rows saved before the flat-candle fix are cleaned on load and re-saved once. v17.8: `strict` → a
 * Redis error throws instead of reading as an empty store (a write merged over "empty" would wipe the history).
 */
export async function loadDk(redis: Redis, id: string, strict = false): Promise<DkBar[]> {
  const raw = strict ? await redis.get(dkKey(id)) : await redis.get(dkKey(id)).catch(() => null);
  if (!raw) return [];
  let bars: DkBar[];
  try {
    bars = (JSON.parse(raw) as number[][]).map(([t, o, h, l, c, s]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, s: s ?? 0 }));
  } catch {
    return [];
  }
  const clean = cleanDk(bars);
  if (clean.length !== bars.length) {
    log.info({ id, removed: bars.length - clean.length }, 'dukascopy: removed flat / weekend filler bars');
    await saveDk(redis, id, clean).catch(() => undefined);
  }
  return clean;
}

async function saveDk(redis: Redis, id: string, bars: readonly DkBar[]): Promise<void> {
  await redis.set(dkKey(id), JSON.stringify(bars.map((b) => [b.t, px7(b.o), px7(b.h), px7(b.l), px7(b.c), Math.round(b.s * 100) / 100])));
}

/** Merge newer bars over older ones by time. Pure. */
export function mergeDk(have: readonly DkBar[], fresh: readonly DkBar[]): DkBar[] {
  const m = new Map(have.map((b) => [b.t, b]));
  for (const b of fresh) m.set(b.t, b);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/**
 * v17.8: write `bars` merged over what is stored NOW (re-read right before the write), trimmed to `historyDays` + 5.
 * The 6-hourly refresh holds its copy of a store for minutes while it back-fills, and the hourly run's tail fetch (maybe
 * in the child process) writes the same key: without the re-read the later save dropped the other's bars (a 3-day tail
 * wiping the 3-year history). Returns what was saved (nothing is written when it is empty) and what was stored before.
 * A failed re-read throws (nothing written), like a failed write.
 */
async function saveMerged(redis: Redis, id: string, bars: readonly DkBar[], now: number): Promise<{ saved: DkBar[]; stored: DkBar[] }> {
  const stored = await loadDk(redis, id, true);
  const saved = mergeDk(stored, bars).filter((b) => b.t >= now - (DK.historyDays + 5) * DAY);
  if (saved.length) await saveDk(redis, id, saved);
  return { saved, stored };
}

/**
 * Older Dukascopy history in front of the Yahoo bars (FX only). Stitched only when the seam lines up (the last
 * Dukascopy close before Yahoo's first bar is within `DK.maxSeamGap` of Yahoo's first open). Pure.
 */
export function stitchHistory(id: string, yahoo: readonly Bar[], dk: readonly DkBar[], now: number, days = DK.historyDays): Bar[] {
  if (!yahoo.length || !dk.length || instrument(id)?.kind === 'metal') return [...yahoo];
  const first = yahoo[0]!.t;
  const older = dk.filter((b) => b.t < first && b.t >= now - days * DAY);
  if (!older.length) return [...yahoo];
  const seam = older[older.length - 1]!;
  if (first - seam.t > 4 * DAY) return [...yahoo];
  if (Math.abs(seam.c - yahoo[0]!.o) / yahoo[0]!.o > DK.maxSeamGap) return [...yahoo];
  return [...older.map(({ t, o, h, l, c }) => ({ t, o, h, l, c })), ...yahoo];
}

/** v17: the newest hours of a few markets, fetched only for markets whose Yahoo candles fell behind (`fill.ts`). */
export const DK_TAIL = { days: 3, minGapMs: 10 * 60_000, budgetMs: 60_000, minCallMs: 5_000 };
const tailAt = new Map<string, number>();

/**
 * Pull the last few days of hourly candles for `ids` from Dukascopy (each at most once per 10 minutes, no new market
 * started after `budgetMs`, nothing while Dukascopy's breaker is open) and merge them into the stored history. Never
 * throws. v17: a market's bid gets only what is left of the budget (at least `minCallMs`, never more than the whole
 * budget or `DK.timeoutMs`); a bid cut off by the budget is an error (nothing saved) and ends the run, whatever the
 * clocks say. v17.8: the budget is checked only before STARTING a market — once its bid is in, the ask runs under the
 * normal per-request cap (`DK.timeoutMs`), so fetched data is never thrown away by our own budget (a market may run up
 * to one cap past it). A cut made by our budget is only that market's error — never a Dukascopy failure (it would open
 * the shared breaker and pause the backup live prices too); real errors and the per-request cap's timeouts still are.
 * The save merges over what is stored at that moment (`saveMerged`).
 */
export async function refreshDkTail(redis: Redis, ids: readonly string[], now = Date.now(), fetcher: Fetch = fetchDk): Promise<Record<string, { lastT: number | null; added: number; error: string | null }>> {
  const out: Record<string, { lastT: number | null; added: number; error: string | null }> = {};
  const t0 = Date.now();
  const spent = () => Date.now() - t0 >= DK_TAIL.budgetMs;
  let cut = false;
  /** the bid: what is left of the budget; a timeout is ours only when the budget, not the per-request cap, set it */
  const timedBid = <T>(p: Promise<T>, what: string): Promise<T> => {
    const ms = Math.min(DK.timeoutMs, Math.max(Math.min(DK_TAIL.minCallMs, DK_TAIL.budgetMs), DK_TAIL.budgetMs - (Date.now() - t0)));
    const ours = ms < DK.timeoutMs;
    return withTimeout(p, ms, what).catch((err: unknown) => {
      if (ours && err instanceof DkTimeoutError && err.what === what) cut = true;
      throw err;
    });
  };
  for (const id of ids) {
    if (cut || spent() || !feeds.allow('dukascopy')) break;
    if (now - (tailAt.get(id) ?? 0) < DK_TAIL.minGapMs) continue;
    tailAt.set(id, now);
    const have = await loadDk(redis, id);
    const from = Math.max((have[have.length - 1]?.t ?? 0) - 2 * HOUR, now - DK_TAIL.days * DAY);
    try {
      const bid = await timedBid(fetcher(id, 'bid', new Date(from), new Date(now)), `dukascopy tail ${id} bid`);
      // v17.8: the bid is in — the ask gets the normal per-request cap, never what is left of the budget
      const ask = await withTimeout(fetcher(id, 'ask', new Date(from), new Date(now)), DK.timeoutMs, `dukascopy tail ${id} ask`);
      const fresh = midBars(id, bid, ask, now);
      let last = have[have.length - 1]?.t ?? null;
      let added = 0;
      if (fresh.length) {
        const { saved, stored } = await saveMerged(redis, id, fresh, now);
        const prevLast = stored[stored.length - 1]?.t ?? 0;
        last = saved[saved.length - 1]?.t ?? null;
        added = saved.filter((b) => b.t > prevLast).length;
      }
      out[id] = { lastT: last, added, error: null };
      feeds.ok('dk-history', { items: fresh.length, asOf: last });
    } catch (err) {
      // v17.8: a bid cut by our own budget is this market's error only, not a Dukascopy failure
      out[id] = { lastT: have[have.length - 1]?.t ?? null, added: 0, error: cut ? `${(err as Error).message} (the run's time budget ran out)` : (err as Error).message };
      if (!cut) feeds.fail('dk-history', err);
      if (cut || spent()) break;
    }
  }
  return out;
}

/** Install the hourly spread profile of every market from its stored Dukascopy bars. */
export async function installSpreadProfiles(redis: Redis, now = Date.now()): Promise<number> {
  let n = 0;
  for (const inst of INSTRUMENTS) {
    const bars = await loadDk(redis, inst.id);
    const recent = bars.filter((b) => b.t >= now - DK.spreadDays * DAY).map((b) => [b.t, b.s] as const);
    const p = profileFrom(recent);
    setSpreadProfile(inst.id, p);
    if (p) n++;
  }
  return n;
}

/**
 * Refresh every market's Dukascopy history (first time: `historyDays` back in pieces; then the newest days), then
 * install the spread profiles. Never throws; one market failing doesn't stop the others.
 * v17: a non-empty store that doesn't reach `historyDays` back (the lab's tail fetch on an empty store saves only 3 days)
 * gets the older range back-filled, each piece ending at the oldest bar so far (a failure leaves no hole; the next
 * refresh goes on from there); a piece that brings nothing older ends it. "No error" is NOT proof that nothing older
 * exists — dukascopy-node answers HTTP errors / throttling with an empty result — so `full` (no more back-fill) only
 * when the store reaches back, or after `DK.backfillTries` back-fills in a row brought nothing older (kept while the
 * store still starts there). Until then a short store is reported as an error and retried every refresh.
 */
/** v18.6: can this server reach Dukascopy's data host at all? dukascopy-node answers a blocked / throttled host with an
 * EMPTY result and no error (so the Setup card said "0 bars · 0 failed" for a day). One tiny request first: any HTTP
 * answer = reachable; a network error / timeout = the reason, in words. */
export async function probeDukascopy(timeoutMs = 10_000): Promise<string | null> {
  try {
    const res = await fetch('https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/00h_ticks.bi5', { method: 'GET', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0' } });
    if (res.status >= 500) return `datafeed.dukascopy.com answered HTTP ${res.status}`;
    if (res.status === 403 || res.status === 429) return `datafeed.dukascopy.com refused this server (HTTP ${res.status}: blocked or throttled)`;
    return null;
  } catch (err) {
    return `can't reach datafeed.dukascopy.com: ${(err as Error).name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : (err as Error).message}`;
  }
}

export async function refreshDukascopy(redis: Redis, now = Date.now(), fetcher: Fetch = fetchDk): Promise<DkMeta> {
  let prev: DkMeta | null = null;
  try {
    prev = JSON.parse((await redis.get(DK_META)) ?? 'null') as DkMeta | null;
  } catch {
    prev = null;
  }
  if (prev && now - prev.at < DK.refreshHours * 3_600_000) {
    await installSpreadProfiles(redis, now);
    return prev;
  }
  // v18.6: the real fetcher only — a host we can't reach is reported as the reason instead of 22 silent empty answers
  if (fetcher === fetchDk) {
    const why = await probeDukascopy();
    if (why) {
      feeds.fail('dk-history', why);
      log.warn({ why }, 'dukascopy unreachable — history refresh skipped');
      return prev ?? { at: 0, ids: {} };
    }
  }
  const meta: DkMeta = { at: now, ids: {} };
  const ids = [...INSTRUMENTS.map((i) => i.id), ...STRENGTH_PAIRS.map((p) => p.id)];
  const histFrom = now - DK.historyDays * DAY;
  const slack = DK.slackDays * DAY;
  for (const id of ids) {
    const have = await loadDk(redis, id);
    const was = prev?.ids?.[id];
    const start = have.length ? Math.max(have[have.length - 1]!.t - DAY, histFrom) : histFrom;
    // v17: older range still missing? (not when it reaches back, or a complete download said there's nothing older)
    const reaches = have.length > 0 && have[0]!.t <= histFrom + slack;
    const fullKept = was?.full === true && have.length > 0 && typeof was.firstT === 'number' && have[0]!.t <= was.firstT + slack;
    const backTo = have.length && !reaches && !fullKept ? have[0]!.t : null;
    let bars = have;
    let error: string | null = null;
    const piece = async (from: number, to: number) => {
      const [bid, ask] = [await fetcher(id, 'bid', new Date(from), new Date(to)), await fetcher(id, 'ask', new Date(from), new Date(to))];
      bars = mergeDk(bars, midBars(id, bid, ask, now));
      if (DK.pauseMs > 0) await new Promise((r) => setTimeout(r, DK.pauseMs));
    };
    const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (let from = start; from < now; from += DK.chunkDays * DAY) {
      try {
        await piece(from, Math.min(now, from + DK.chunkDays * DAY));
      } catch (err) {
        error = (err as Error).message;
        break;
      }
    }
    // v17: back-fill [histFrom, oldest bar): each piece ends at the oldest bar so far; one that brings nothing older ends it
    let progressed = false;
    if (backTo !== null && !error) {
      for (let n = 0, to = Math.min(backTo, bars[0]!.t); to > histFrom && n < 2 * Math.ceil(DK.historyDays / DK.chunkDays); n++) {
        try {
          await piece(Math.max(histFrom, to - DK.chunkDays * DAY), to);
        } catch (err) {
          error = `older history: ${(err as Error).message}`;
          break;
        }
        if (bars[0]!.t >= to) break;
        progressed = true;
        to = bars[0]!.t;
      }
    }
    // v17.8: saved merged over the store as it is NOW (the hourly tail fetch may have written while this back-filled),
    // trimmed to historyDays + 5; `full` and the meta below describe what was actually saved (a failed save: the store
    // as last read, and this market's error)
    try {
      bars = (await saveMerged(redis, id, bars, now)).saved;
    } catch (err) {
      bars = have;
      error = `couldn't save: ${(err as Error).message}`;
    }
    // v17: `full` only on proof — the store reaches back, or a finished back-fill was kept (`fullKept`), or the back-fill
    // brought nothing older `backfillTries` times in a row; a short store is an error until then (retried each refresh)
    let full = bars.length > 0 && bars[0]!.t <= histFrom + slack;
    let tries = 0;
    let note: string | undefined;
    // v18.6: nothing stored and nothing came back without an error = the library swallowed a refusal
    if (!bars.length && !error) error = 'empty answer from Dukascopy (blocked, throttled or the feed moved) — will retry';
    if (!full && have.length && backTo === null) {
      full = true; // fullKept
      tries = was?.tries ?? 0;
      note = was?.note;
    } else if (!full && error) tries = backTo !== null && !progressed ? (was?.tries ?? 0) : 0;
    else if (!full && bars.length) {
      const since = dayOf(bars[0]!.t);
      if (backTo !== null && !progressed) {
        tries = (was?.tries ?? 0) + 1;
        if (tries >= DK.backfillTries) {
          full = true;
          note = `older history: nothing before ${since} in ${tries} back-fills in a row — taken as where the data starts`;
        } else error = `older history: nothing returned before ${since} (back-fill ${tries} of ${DK.backfillTries}), will retry`;
      } else error = `older history: only back to ${since} so far, will retry`;
    }
    meta.ids[id] = { bars: bars.length, firstT: bars[0]?.t ?? null, lastT: bars[bars.length - 1]?.t ?? null, error, full, ...(tries ? { tries } : {}), ...(note ? { note } : {}) };
    if (error) log.warn({ id, err: error }, 'dukascopy refresh failed');
  }
  await redis.set(DK_META, JSON.stringify(meta)).catch(() => undefined);
  const errs = Object.entries(meta.ids).filter(([, v]) => v.error);
  const newest = Math.max(0, ...Object.values(meta.ids).map((v) => v.lastT ?? 0)) || null;
  if (errs.length < Object.keys(meta.ids).length) feeds.ok('dk-history', { items: Object.keys(meta.ids).length - errs.length, asOf: newest });
  else feeds.fail('dk-history', errs[0]?.[1].error ?? 'every market failed');
  const profiles = await installSpreadProfiles(redis, now);
  log.info({ markets: Object.keys(meta.ids).length, profiles }, 'dukascopy history refreshed');
  return meta;
}
