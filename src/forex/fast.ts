/**
 * Forex fast charts (v15, owner: "trade on a 15 min timer, 1 min too"): the same strategies on 15-minute and 1-minute
 * candles.
 *  - Data: OANDA candles when a token is saved (210 days of 15m, 21 days of 1m), else Yahoo (60 days of 15m, 21 days
 *    of 1m, 7 days per request), merged into Redis `fx:bars:15m:<id>` / `fx:bars:1m:<id>`; the 15m history grows.
 *  - Test (every hour at :31): every strategy that suits short charts, raw and with each filter and exit, picked on
 *    the first 70% of THAT chart's own history, verdict against random entries on the same chart, paper results since
 *    `fx:fast:since`. Redis `fx:fast:report`, `fx:fast:chosen`.
 *  - Live (each 15m close + 40 s; every minute + 20 s with OANDA, every 2 minutes with Yahoo): the open trades of the
 *    strategies that passed, on the newest candles, go to the bot account (`syncBot`, only its own charts).
 * Spreads are the same as on the hourly charts, so on 1-minute candles they eat a big part of every move: the tests
 * show what is left after them. The signal judge and the whole-bot test stay on the hourly charts. No real orders.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import { dataAgeOf, FRESH, staleReason, type DataAge } from './freshness';
import { fetchYahooBars, loadFastBars, mergeBars, saveFastBars, trimBars } from './data';
import { loadOanda, oandaCandles, oandaReady } from './oanda';
import { signalsFor, simulate, WARMUP } from './engine';
import { STRATEGIES, runsOn, strategyById, styleOf } from './strategies';
import { to4h } from './ta';
import { INSTRUMENTS, TF_MIN, type Bar, type Instrument, type Trade } from './types';
import { allowFor, blockReason, filterCoverage, missingInput } from './filters';
import { applyExit } from './exits';
import { stratFactorFromVerdict, volFactor } from './portfolio';
import { marketClock } from './calendar';
import { newSyncReport, type LabOpenTrade } from './practice';
import { withEnd } from './mtf';
import { FX_CONFIG, applyHmm, bigChart, evaluateTf, makeSeries, paperSince, pickedOnInSample, prevPicks, signalIndex, slimTrade, toLabTrade, type BigChart, type ChosenStore, type ForexLab, type MarketBook, type PaperRow, type Row, type Series } from './lab';
import type { HmmModel } from './hmm';
import { agreeCount, boostFor, gradeConviction, maxConfirmations, tierOf, type ConvictionReport, type ConvRow } from './conviction';

const log = moduleLogger('forex-fast');
export type FastTf = '15m' | '1m';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const FX_FAST = {
  tfs: ['15m', '1m'] as FastTf[],
  /** history kept per market (≈ 14k 15-minute bars, ≈ 21k 1-minute bars: what one test uses at most) */
  keepDays: { '15m': 210, '1m': 21 } as Record<FastTf, number>,
  /** most bars stored per market */
  maxStore: { '15m': 21_000, '1m': 24_000 } as Record<FastTf, number>,
  /** most bars tested per market (memory / CPU bound: the test shares the bot's process; ≈ 10 trading days of 1m,
   * ≈ 145 of 15m) */
  maxEvalBars: 14_000,
  /** fewest bars a market needs before it is tested */
  minEvalBars: 1_500,
  /** bars of recent history for the live pass. v17: 15m covers the volatility forecast's month of warm-up (22 × 96 + 1
   * bars) so a check tested with it isn't always blank live; on 1m it is blank in the tested history too (never required) */
  liveBars: { '15m': 2_300, '1m': 2_000 } as Record<FastTf, number>,
  /** seconds between 1-minute checks with OANDA / with Yahoo (Yahoo is rate-limited) */
  oneMinuteEverySec: { oanda: 60, yahoo: 120 },
  /** how far back Yahoo serves intraday bars */
  yahooDays: { '15m': 59, '1m': 29 } as Record<FastTf, number>,
};
export const FX_FAST_REPORT = 'fx:fast:report';
export const FX_FAST_SINCE = 'fx:fast:since';
export const FX_FAST_CHOSEN = 'fx:fast:chosen';

export interface FastFeed {
  id: string;
  tf: FastTf;
  bars: number;
  firstT: number | null;
  lastT: number | null;
  source: 'oanda' | 'yahoo' | null;
  error: string | null;
}

export interface FastReport {
  at: number;
  durationMs: number;
  feed: FastFeed[];
  /** history tested per chart, and where its unseen last 30% starts */
  spans: Record<FastTf, { from: number | null; to: number | null; oosFrom: number | null; markets: number }>;
  rows: Row[];
  paper: { since: number; rows: PaperRow[]; open: Trade[]; recent: Trade[] };
  /** v15.2: bigger size when more sure, per chart (market checks only: no judge here) */
  conviction?: Partial<Record<FastTf, ConvictionReport>>;
  /** v17: per chart × market, how often each filter input was known on that chart's first 70% (the bars before its
   * `oosFrom` = the history the rows' filters were picked on); the live missing-data guard reads this (`liveCoverage`) */
  coverage?: Partial<Record<FastTf, Record<string, FilterCoverage>>>;
  /** v18: per chart × market, the regime model fitted on that chart's first 70% (the live pass reads the newest candles with it) */
  hmm?: Partial<Record<FastTf, Record<string, HmmModel>>>;
  note: string;
}
type FilterCoverage = ReturnType<typeof filterCoverage>;

/** What fired on a chart's newest close, per market (the bot's plan). */
export interface FastFiring {
  tf: FastTf;
  /** open time of the newest closed bar */
  t: number;
  at: number;
  byPair: Record<string, Array<{ id: string; name: string; side: 1 | -1; allowed: boolean; why: string | null; chosen: boolean }>>;
}

/** Where the candles come from (swappable in tests). */
export interface FastSource {
  /** OANDA connected: deeper history, 1-minute checks every minute */
  oanda(): Promise<boolean>;
  /** closed bars from `fromT` up to now (as many as the source serves) */
  bars(inst: Instrument, tf: FastTf, fromT: number, now: number): Promise<{ bars: Bar[]; source: 'oanda' | 'yahoo' }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const yieldNow = () => new Promise((r) => setImmediate(r));

export const DEFAULT_FAST_SOURCE: FastSource = {
  async oanda() {
    return oandaReady(await loadOanda());
  },
  async bars(inst, tf, fromT, now) {
    const barMs = TF_MIN[tf] * MIN;
    const s = await loadOanda();
    if (oandaReady(s)) {
      // page back from now, 5,000 candles a page, until `fromT` (complete candles only)
      let out: Bar[] = [];
      let to: number | undefined;
      for (let page = 0; page < 12; page++) {
        const need = Math.ceil(((to ?? now) - fromT) / barMs) + 2;
        if (need <= 0) break;
        const cs = await oandaCandles(s, inst.id, tf === '1m' ? 'M1' : 'M15', Math.min(5_000, Math.max(3, need)), to);
        const got = cs.filter((c) => c.complete).map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
        if (!got.length) break;
        out = mergeBars(out, got);
        if (got[0]!.t <= fromT || cs.length < Math.min(5_000, need)) break;
        to = got[0]!.t;
        await sleep(120);
      }
      return { bars: out.filter((b) => b.t >= fromT - barMs), source: 'oanda' };
    }
    // Yahoo: 15m up to 60 days back, 1m up to 30 days back in 7-day requests
    const oldest = now - FX_FAST.yahooDays[tf] * DAY;
    const from = Math.max(fromT, oldest);
    const step = tf === '1m' ? 7 * DAY : 60 * DAY;
    // one failed 7-day piece must not throw away the others; fail only when every piece failed
    let out: Bar[] = [];
    let last: Error | null = null;
    let ok = 0;
    for (let a = from; a < now; a += step) {
      try {
        out = mergeBars(out, await fetchYahooBars(inst.yahoo, tf, { from: a, to: Math.min(now, a + step) }, now));
        ok++;
      } catch (err) {
        last = err as Error;
      }
      if (a + step < now) await sleep(400);
    }
    if (!ok && last) throw last;
    return { bars: out, source: 'yahoo' };
  },
};

/** The fast-chart strategies the bot trades: passed on unseen data, not dropped for losing in its account. Pure. */
export const chosenOf = (rows: ReadonlyArray<Pick<Row, 'id' | 'tf' | 'verdict'>>, dropped: readonly string[]) =>
  rows.filter((r) => r.id !== 'random' && r.verdict !== 'no' && !dropped.includes(`${r.id}:${r.tf}`)).map((r) => `${r.id}:${r.tf}`);

/** v17: filter-input coverage of one tested series on its first 70% (bars before `oosFrom`, as the hourly lab measures it). Pure. */
export function testedCoverage(se: Pick<Series, 'ctx' | 'env'>, oosFrom: number): FilterCoverage {
  if (!se.env) return {};
  const upTo = se.ctx.bars.findIndex((b) => b.t >= oosFrom);
  return filterCoverage(se.env, upTo < 0 ? se.ctx.bars.length : upTo);
}

/**
 * v17: the coverage the live missing-data guard compares against: the one stored with the hourly fast test (that
 * chart's first 70% — the history the row's filter was picked on), so a feed that has been down for hours can't pull
 * the live window under the 80% bar and switch the guard off. A report from before this (or a market the test didn't
 * have) falls back to the first 70% of the live window. Pure.
 */
export function liveCoverage(rep: Pick<FastReport, 'coverage'> | null | undefined, tf: FastTf, pair: string, se: Pick<Series, 'ctx' | 'env'>): FilterCoverage {
  const stored = rep?.coverage?.[tf]?.[pair];
  if (stored) return stored;
  return se.env ? filterCoverage(se.env, Math.floor(se.ctx.bars.length * 0.7)) : {};
}

/** The next run time on a grid: every `periodMs`, `offsetMs` past each boundary. Pure. */
export function nextOnGrid(now: number, periodMs: number, offsetMs: number): number {
  return Math.floor((now - offsetMs) / periodMs) * periodMs + periodMs + offsetMs;
}

export class FastLab {
  private bars = new Map<string, Bar[]>();
  private dirty = new Set<string>();
  private loaded: Promise<void> | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private evaluating: Promise<FastReport | null> | null = null;
  private deciding = new Set<FastTf>();
  /** last full backfill attempt per series (at most one per 6 hours) */
  private backfilledAt = new Map<string, number>();
  private bigCache: { at: number; byId: Map<string, { h1: BigChart; h4: BigChart }> } | null = null;
  private oandaOn = false;
  /** one candle pull per chart at a time */
  private refreshing = new Map<FastTf, Promise<void>>();
  report: FastReport | null = null;
  firing: Partial<Record<FastTf, FastFiring>> = {};
  feed = new Map<string, FastFeed>();
  /** strategy:chart combinations the bot trades on the fast charts */
  chosen: string[] = [];
  /** open trades of those strategies per chart (`strategy:tf:pair` → entry time), for the plan */
  labOpen: Partial<Record<FastTf, Record<string, number>>> = {};
  /** v17: data age of every market per fast chart (set at each live check) */
  dataAge: Partial<Record<FastTf, Record<string, DataAge>>> = {};
  constructor(
    private readonly redis: Redis,
    private readonly lab: ForexLab,
    private readonly src: FastSource = DEFAULT_FAST_SOURCE,
  ) {}

  private key = (tf: FastTf, id: string) => `${tf}:${id}`;
  series(tf: FastTf, id: string): Bar[] {
    return this.bars.get(this.key(tf, id)) ?? [];
  }

  start(): void {
    void this.redis
      .get(FX_FAST_REPORT)
      .then((raw) => {
        if (raw && !this.report) {
          this.report = JSON.parse(raw) as FastReport;
          this.chosen = chosenOf(this.report.rows, this.lab.dropped);
        }
      })
      .catch(() => undefined);
    // candles first (backfill), then the first test once the hourly market read exists
    void this.ensureLoaded()
      .then(async () => {
        for (const tf of FX_FAST.tfs) await this.refresh(tf, Date.now());
      })
      .catch(() => undefined);
    this.after('eval0', 5 * MIN, () => this.evaluate());
    this.every('eval', (now) => nextOnGrid(now, HOUR, 31 * MIN), () => this.evaluate());
    this.every('15m', (now) => nextOnGrid(now, 15 * MIN, 40_000), () => this.decide('15m'));
    this.every('1m', (now) => nextOnGrid(now, (this.oandaOn ? FX_FAST.oneMinuteEverySec.oanda : FX_FAST.oneMinuteEverySec.yahoo) * 1000, 20_000), () => this.decide('1m'));
    this.every('persist', (now) => now + 10 * MIN, () => this.persist());
  }
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    void this.persist().catch(() => undefined);
  }
  private after(name: string, ms: number, fn: () => Promise<unknown>): void {
    this.timers.set(name, setTimeout(() => void fn().catch(() => undefined), ms));
  }
  private every(name: string, nextAt: (now: number) => number, fn: () => Promise<unknown>): void {
    const arm = () => {
      const now = Date.now();
      this.timers.set(
        name,
        setTimeout(() => {
          void fn()
            .catch((err: Error) => log.warn({ name, err: err.message }, 'forex fast job failed'))
            .finally(arm);
        }, Math.max(1_000, nextAt(now) - now)),
      );
    };
    arm();
  }
  isRunning(): boolean {
    return this.evaluating !== null;
  }

  ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        for (const tf of FX_FAST.tfs) for (const inst of INSTRUMENTS) this.bars.set(this.key(tf, inst.id), await loadFastBars(this.redis, tf, inst.id));
      })();
    }
    return this.loaded;
  }

  async persist(): Promise<void> {
    for (const k of [...this.dirty]) {
      const [tf, id] = k.split(':') as [FastTf, string];
      await saveFastBars(this.redis, tf, id, this.bars.get(k) ?? []);
      this.dirty.delete(k);
    }
  }

  /** Pull the newest candles of one chart for every market (a full backfill when a market has too little). */
  refresh(tf: FastTf, now = Date.now()): Promise<void> {
    const running = this.refreshing.get(tf);
    if (running) return running;
    const p = this.doRefresh(tf, now).finally(() => this.refreshing.delete(tf));
    this.refreshing.set(tf, p);
    return p;
  }

  private async doRefresh(tf: FastTf, now: number): Promise<void> {
    await this.ensureLoaded();
    this.oandaOn = await this.src.oanda().catch(() => false);
    const barMs = TF_MIN[tf] * MIN;
    for (const inst of INSTRUMENTS) {
      const k = this.key(tf, inst.id);
      const have = this.bars.get(k) ?? [];
      const lastT = have[have.length - 1]?.t ?? 0;
      const thin = have.length < FX_FAST.minEvalBars || now - lastT > 6 * DAY;
      let fromT = lastT ? lastT - 2 * barMs : now - FX_FAST.keepDays[tf] * DAY;
      if (thin && now - (this.backfilledAt.get(k) ?? 0) > 6 * HOUR) {
        fromT = now - FX_FAST.keepDays[tf] * DAY;
        this.backfilledAt.set(k, now);
      }
      try {
        const got = await this.src.bars(inst, tf, fromT, now);
        const merged = trimBars(mergeBars(have, got.bars.filter((b) => b.t + barMs <= now)), now, FX_FAST.keepDays[tf] * DAY, FX_FAST.maxStore[tf]);
        this.bars.set(k, merged);
        if (got.bars.length) this.dirty.add(k);
        this.feed.set(k, { id: inst.id, tf, bars: merged.length, firstT: merged[0]?.t ?? null, lastT: merged[merged.length - 1]?.t ?? null, source: got.source, error: null });
        feeds.ok(got.source === 'oanda' ? 'oanda' : 'yahoo-fast', { items: got.bars.length, asOf: merged[merged.length - 1]?.t ?? null });
      } catch (err) {
        if (!/^yahoo paused/.test((err as Error).message)) feeds.fail(this.oandaOn ? 'oanda' : 'yahoo-fast', err);
        const prev = this.feed.get(k);
        this.feed.set(k, { id: inst.id, tf, bars: have.length, firstT: have[0]?.t ?? null, lastT: lastT || null, source: prev?.source ?? null, error: (err as Error).message });
      }
      await sleep(this.oandaOn ? 50 : 250);
    }
  }

  /** The two bigger charts a fast chart checks: 15m → 1h + 4h, 1m → 15m + 1h (finished bars only). */
  private bigFor(tf: FastTf, id: string, book: MarketBook): [BigChart | null, BigChart | null] {
    if (!this.bigCache || this.bigCache.at !== book.at) this.bigCache = { at: book.at, byId: new Map() };
    let hourly = this.bigCache.byId.get(id);
    if (!hourly) {
      const h1 = book.h1.get(id) ?? [];
      hourly = { h1: bigChart(withEnd(h1, HOUR)), h4: bigChart(withEnd(to4h(h1), 4 * HOUR)) };
      this.bigCache.byId.set(id, hourly);
    }
    if (tf === '15m') return [hourly.h1, hourly.h4];
    const b15 = this.series('15m', id).slice(-4_000);
    return [b15.length >= 60 ? bigChart(withEnd(b15, 15 * MIN)) : null, hourly.h1];
  }

  /** The hourly test of every strategy on the 15m and 1m charts. */
  evaluate(now = Date.now()): Promise<FastReport | null> {
    if (this.evaluating) return this.evaluating;
    this.evaluating = this.doEvaluate(now)
      .then((r) => {
        // v18.6: the Setup card's "15m / 1m test run" row (it never reported before: showed "never")
        if (r) feeds.ok('fast-lab', { items: r.rows.length, asOf: r.at });
        return r;
      })
      .catch((err: unknown) => {
        feeds.fail('fast-lab', err instanceof Error ? err : new Error(String(err)));
        throw err;
      })
      .finally(() => {
        this.evaluating = null;
      });
    return this.evaluating;
  }

  private async doEvaluate(now: number): Promise<FastReport | null> {
    const book = this.lab.book;
    if (!book) return null;
    await this.ensureLoaded();
    const t0 = Date.now();
    const since = await paperSince(this.redis, FX_FAST_SINCE, now);
    // v17.8: last test's picks per chart, only while that chart's 70/30 line hasn't moved back (`prevPicks`); the old
    // unstamped format is ignored once (one re-pick after the deploy)
    const prevRaw = await this.redis.get(FX_FAST_CHOSEN).catch(() => null);
    const rows: Row[] = [];
    const paperRows: PaperRow[] = [];
    const open: Trade[] = [];
    const recent: Trade[] = [];
    const spans = { '15m': { from: null, to: null, oosFrom: null, markets: 0 }, '1m': { from: null, to: null, oosFrom: null, markets: 0 } } as FastReport['spans'];
    const conviction: Partial<Record<FastTf, ConvictionReport>> = {};
    const coverage: NonNullable<FastReport['coverage']> = {};
    const hmm: NonNullable<FastReport['hmm']> = {};
    for (const tf of FX_FAST.tfs) {
      let series: Series[] = [];
      let from = Infinity;
      let to = -Infinity;
      for (const inst of INSTRUMENTS) {
        const all = this.series(tf, inst.id);
        if (all.length < FX_FAST.minEvalBars) continue;
        const bars = all.slice(-FX_FAST.maxEvalBars);
        const [b1, b2] = this.bigFor(tf, inst.id, book);
        series.push(makeSeries(inst, tf, bars, book, b1, b2));
        from = Math.min(from, bars[0]!.t);
        to = Math.max(to, bars[bars.length - 1]!.t);
        await yieldNow();
      }
      if (!series.length) continue;
      const oosFrom = from + 0.7 * (to - from);
      // v15.2: closed trades of the strategies picked on the first 70%, with how many market checks backed them
      const byPair = new Map(series.map((se) => [se.inst.id, se]));
      const conv: ConvRow[] = [];
      const ev = await evaluateTf(series, tf, { oosFrom, since, weeks: Math.max(0.2, (to - from) / (7 * DAY)), prev: prevPicks(prevRaw, tf, oosFrom) }, (x) => {
        if (x.s.id === 'random' || !pickedOnInSample(x.ch.inSample)) return;
        for (const t of x.done) {
          const se = byPair.get(t.pair);
          const si = se ? signalIndex(se.ctx.bars, t.entryT, se.ctx.barMin) : -1;
          if (se && si >= 0) conv.push({ t: t.entryT, exitT: t.exitT, r: t.r, conf: agreeCount(se.env, si, t.side) });
        }
      });
      conviction[tf] = gradeConviction(conv, oosFrom, tf, false, { pHi: null, pTop: null });
      // v17: what the live missing-data guard compares against (each market's bars before this chart's oosFrom);
      // v18: after the test, so the regime model's reading counts among the inputs
      coverage[tf] = Object.fromEntries(series.map((se) => [se.inst.id, testedCoverage(se, oosFrom)]));
      hmm[tf] = Object.fromEntries(series.flatMap((se) => (se.hmm ? [[se.inst.id, se.hmm]] : [])));
      rows.push(...ev.rows);
      paperRows.push(...ev.paperRows);
      open.push(...ev.open);
      recent.push(...ev.recent);
      spans[tf] = { from, to, oosFrom, markets: series.length };
      series = [];
    }
    rows.sort((a, b) => b.outSample.avgR * Math.min(1, b.outSample.n / 30) - a.outSample.avgR * Math.min(1, a.outSample.n / 30));
    paperRows.sort((a, b) => b.stats.totalR - a.stats.totalR);
    recent.sort((a, b) => b.exitT - a.exitT);
    open.sort((a, b) => b.entryT - a.entryT);
    const pass = rows.filter((r) => r.verdict !== 'no').length;
    const days = (tf: FastTf) => (spans[tf].from !== null ? Math.round((spans[tf].to! - spans[tf].from!) / DAY) : 0);
    this.report = {
      at: Date.now(),
      durationMs: Date.now() - t0,
      feed: [...this.feed.values()],
      spans,
      rows,
      paper: { since, rows: paperRows, open: open.slice(0, 200).map(slimTrade), recent: recent.slice(0, 150).map(slimTrade) },
      conviction,
      coverage,
      hmm,
      note: rows.length
        ? `${rows.length} strategy × chart combinations on the 15-minute (${days('15m')} days of history) and 1-minute (${days('1m')} days) charts, same spreads as everywhere. ${pass} pass on their unseen last 30%. Short histories: the paper results decide.`
        : 'Not enough 15-minute / 1-minute candles yet (the server keeps collecting them).',
    };
    this.chosen = chosenOf(rows, this.lab.dropped);
    await this.redis.set(FX_FAST_REPORT, JSON.stringify(this.report)).catch(() => undefined);
    const chosenStore: ChosenStore = {
      oosFrom: Object.fromEntries(FX_FAST.tfs.flatMap((tf) => (spans[tf].oosFrom !== null ? [[tf, spans[tf].oosFrom]] : []))),
      picks: Object.fromEntries(rows.map((r) => [`${r.id}:${r.tf}`, { f: r.filter, e: r.exit }])),
    };
    await this.redis.set(FX_FAST_CHOSEN, JSON.stringify(chosenStore)).catch(() => undefined);
    log.info({ rows: rows.length, pass, ms: this.report.durationMs }, 'forex fast test done');
    return this.report;
  }

  /**
   * The live pass on one chart: fresh candles → what fired on the newest close (all strategies, for the plan) → the
   * open trades of the strategies that passed their test (filter + exit as tested) → the bot account.
   */
  async decide(tf: FastTf, now = Date.now()): Promise<void> {
    const book = this.lab.book;
    if (!book || this.deciding.has(tf) || !marketClock(now).open) return;
    this.deciding.add(tf);
    try {
      await this.refresh(tf, now);
      const rowsTf = (this.report?.rows ?? []).filter((r) => r.tf === tf && r.id !== 'random');
      const rec = await this.lab.botRecord();
      const keep = new Set(chosenOf(rowsTf, rec.dropped));
      const chosenRows = rowsTf.filter((r) => keep.has(`${r.id}:${r.tf}`));
      this.chosen = [...this.chosen.filter((k) => !k.endsWith(`:${tf}`)), ...keep];
      // strategies the bot still holds a trade from on this chart keep being followed (their stop, their exit) even
      // when they are no longer chosen: a verdict flip stops new entries, it never closes a running trade early
      const practice = this.lab.practice;
      const heldIds = new Set(((await practice?.heldRefs().catch(() => [] as string[])) ?? []).filter((r) => r.split(':')[1] === tf).map((r) => r.split(':')[0]!));
      const followRows = rowsTf.filter((r) => keep.has(`${r.id}:${r.tf}`) || heldIds.has(r.id));
      const labOpen: LabOpenTrade[] = [];
      const openKeys: Record<string, number> = {};
      const byPair: FastFiring['byPair'] = {};
      let newest = 0;
      /** v17: markets this pass really looked at (enough candles, the newest one recent) — a held trade on any other market is kept, not closed */
      const pairsSeen = new Set<string>();
      /** v17: how far behind each market's candles are (a lagging market gets no new trades) */
      const ages: Record<string, DataAge> = {};
      for (const inst of INSTRUMENTS) {
        const all = this.series(tf, inst.id);
        ages[inst.id] = dataAgeOf(inst.id, tf, all, now, TF_MIN[tf] * MIN);
        if (all.length < WARMUP + 60) continue;
        const bars = all.slice(-FX_FAST.liveBars[tf]);
        if (bars[bars.length - 1]!.t + 4 * TF_MIN[tf] * 60_000 >= now) pairsSeen.add(inst.id);
        const [b1, b2] = this.bigFor(tf, inst.id, book);
        const se = makeSeries(inst, tf, bars, book, b1, b2);
        // v18: the regime model this chart's rows were tested with (fitted at the :31 test) reads the live window
        const hm = this.report?.hmm?.[tf]?.[inst.id];
        if (hm) applyHmm(se, hm);
        const last = bars.length - 1;
        newest = Math.max(newest, bars[last]!.t);
        const fired: FastFiring['byPair'][string] = [];
        for (const s of STRATEGIES) {
          if (s.id === 'random' || !runsOn(s, tf)) continue;
          const sig = s.signal(se.ctx, last);
          if (!sig) continue;
          const row = rowsTf.find((r) => r.id === s.id);
          const why = blockReason(row?.filter ?? 'none', se.env, last, sig.side, styleOf(s));
          fired.push({ id: s.id, name: s.name, side: sig.side, allowed: why === null, why, chosen: chosenRows.some((r) => r.id === s.id) });
        }
        if (fired.length) byPair[inst.id] = fired;
        let cov: FilterCoverage | null = null;
        for (const row of followRows) {
          const s = strategyById(row.id);
          if (!s) continue;
          // v18.7: fast charts manage what the bot still holds but open nothing unless switched on
          const isChosen = FX_CONFIG.botFastCharts && keep.has(`${row.id}:${tf}`);
          const sigs = signalsFor(se.ctx, s).map((sg, i) => applyExit(sg, row.exit ?? 'designed', se.ctx, i));
          for (const t of simulate(inst, tf, se.ctx, s.id, sigs, allowFor(row.filter ?? 'none', se.env, styleOf(s)))) {
            if (t.reason !== 'open') continue;
            openKeys[`${t.strategy}:${tf}:${t.pair}`] = t.entryT;
            const sizeF = stratFactorFromVerdict(row.verdict) * volFactor(t.volRatio) * (rec.proven.has(`${s.id}:${tf}`) ? 1.15 : 1) * (rec.down[`${s.id}:${tf}`] ?? 1);
            // v15.2: how many market checks back it, and the size that earns (only once proven on this chart)
            const si = signalIndex(se.ctx.bars, t.entryT, se.ctx.barMin);
            const conf = si >= 0 ? agreeCount(se.env, si, t.side) : 0;
            const b = boostFor(tierOf(conf, false), this.report?.conviction?.[tf]);
            // v17: a check it was tested with has no data at the signal bar right now → the trade waits (measured
            // against the tested history's coverage, stored with the hourly test — not this live window's)
            cov = cov ?? liveCoverage(this.report, tf, inst.id, se);
            const dataWait = si >= 0 ? missingInput(row.filter ?? 'none', se.env, si, cov) : null;
            labOpen.push(toLabTrade(t, { chosen: isChosen, sizeF, prio: row.all.avgR, judge: null, conviction: { tier: b.tier, conf, of: maxConfirmations(tf, false), mult: b.mult, lev: b.lev }, dataWait }));
          }
        }
        await yieldNow();
      }
      this.firing[tf] = { tf, t: newest, at: Date.now(), byPair };
      this.labOpen[tf] = openKeys;
      // no test report yet (or it has no rows for this chart): never manage trades without the lab's view of them
      if (!practice || !rowsTf.length) return;
      const sync = newSyncReport();
      this.dataAge[tf] = ages;
      // v17: the bigger charts, strength and mood all come from the hourly read — too old, no new fast trades at all
      const bookAge = now - book.at;
      const bookWait = bookAge > FRESH.bookMaxAgeMs ? `the hourly market read (bigger charts, strength, mood) is ${Math.round(bookAge / 3_600_000)} h old: no new ${tf} trades` : null;
      const ev = await practice
        .syncBot(labOpen, (pair) => bookWait ?? staleReason(ages[pair], now) ?? this.lab.calendar?.blockFor(pair) ?? this.lab.headlines?.blockFor(pair) ?? null, this.lab.atr1h, { scope: [tf], report: sync, pairsSeen, heat: this.lab.heatNow })
        .catch((err: Error) => [`bot sync (${tf}) failed: ${err.message}`]);
      this.lab.lastSync[tf] = sync;
      this.lab.logBot(ev);
      const fired = Object.values(byPair).flat();
      this.lab.noteRun({ t: Date.now(), tf, signals: fired.length, chosen: fired.filter((f) => f.chosen && f.allowed).length, opened: sync.opened, skipped: sync.skipped.length, waits: sync.waits.length, holding: sync.heldOpen + sync.opened });
    } finally {
      this.deciding.delete(tf);
    }
  }
}
