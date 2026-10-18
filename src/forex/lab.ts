/**
 * Forex lab (v12 → v13): every hour — refresh the candles, run EVERY strategy on every instrument on 1h and 4h bars,
 * raw and with each trade filter (currency strength, bigger-chart trend, market mood, all three), and publish
 * (a) the backtest over the full history with an in-sample / out-of-sample split and weekly results at several risk
 * levels, (b) the PAPER results = trades opened after the lab first started (a true forward test), (c) the whole-bot
 * backtest on the unseen last 30% (strategies AND filters picked on the first 70% only), (d) the live market read:
 * currency strength, market mood, bigger-chart trends, and (e) what prices did after past shock candles.
 * Redis `fx:report`, `fx:paper:since`, `fx:portfolio`. Nothing here places a real order.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { refreshInstrument, refreshSeries, loadBars, type FeedStatus } from './data';
import type { Practice } from './practice';
import type { ForexCalendar } from './calendar';
import type { ForexHeadlines } from './headlines';
import { equityCurve, rStats, signalsFor, simulate, type RiskResult, type RStats } from './engine';
import { STRATEGIES, type Family } from './strategies';
import { buildCtx, to4h, type Ctx } from './ta';
import { drawingsFor, type Drawings } from './drawings';
import { INSTRUMENTS, MOOD_SYMBOLS, STRENGTH_PAIRS, type Bar, type Instrument, type Timeframe, type Trade } from './types';
import { buildStrength, gapSeries, scoreAt, strengthNow, type StrengthNow } from './strength';
import { alignTrend, decisionTimes, toDaily, trendSeries, withEnd } from './mtf';
import { buildMood, moodNow, moodSeries, riskOfLong, type MoodNow } from './mood';
import { FILTERS, FILTER_LABEL, allowFor, blockReason, chooseFilter, type FilterEnv, type FilterKind, type VariantStats } from './filters';
import { SIZING, simulatePortfolio, stratFactorFromStats, stratFactorFromVerdict, volFactor, type PortfolioResult, type PTrade } from './portfolio';
import { newsStudy, type NewsStudy } from './news-study';

const log = moduleLogger('forex-lab');

export const FX_CONFIG = {
  timeframes: ['1h', '4h'] as Timeframe[],
  /** the bot account always trades these (published evidence) on top of whatever the lab marks edge / maybe */
  botAlways: ['tsmom', 'tsmom_long', 'local_hours', 'fix_flow'],
  riskLevelsPct: [0.5, 1, 2, 5],
  /** leverage cap per trade (retail brokers 30–50×; on-chain perps allow more — we don't) */
  maxLeverage: 50,
  oosFraction: 0.3,
  refreshMinutes: 60,
  minOosTrades: 30,
  /** whole-bot backtest: base risk levels tried, and what a strategy needs on the first 70% to be picked */
  portfolioRiskPct: [0.5, 1, 2, 3],
  pick: { minN: 40, minAvgR: 0.05, minPf: 1.15 },
};

export interface VariantRow {
  filter: FilterKind;
  inN: number;
  inAvgR: number;
  outN: number;
  outAvgR: number;
  outPf: number | null;
  allN: number;
}

export interface Row {
  id: string;
  name: string;
  family: Family;
  desc: string;
  tf: Timeframe;
  /** v13: the filter it trades with (picked on the first 70% only) */
  filter: FilterKind;
  /** raw and every filter, side by side */
  variants: VariantRow[];
  all: RStats;
  inSample: RStats;
  outSample: RStats;
  tradesPerWeek: number;
  risk: RiskResult[];
  pairs: Array<{ pair: string } & RStats>;
  /** edge / maybe / no */
  verdict: 'edge' | 'maybe' | 'no';
  why: string;
}

export interface PaperRow {
  id: string;
  name: string;
  tf: Timeframe;
  stats: RStats;
  risk1: RiskResult;
  open: number;
}

export interface MarketNow {
  id: string;
  label: string;
  price: number;
  t: number;
  change24hPct: number;
  /** last 72 hourly closes for a sparkline */
  closes: number[];
  trend: 'up' | 'down' | 'flat';
  rsi: number;
  /** average hourly range in pips */
  atrPips: number;
  /** strategies whose rule fired on the last closed bar, and whether their filter lets the bot take it */
  firing: Array<{ id: string; name: string; tf: Timeframe; side: 1 | -1; allowed: boolean; why: string | null }>;
  openPaper: number;
  /** last 150 hourly bars [t,o,h,l,c] for the chart */
  bars: number[][];
  drawings: Drawings;
  /** v13: trend on the 1h / 4h / daily chart (+1 up, −1 down, 0 none) */
  mtf: { h1: number; h4: number; d1: number };
  /** v13: strength of its two currencies and the gap (base − quote) */
  strength: { base: string; quote: string; baseScore: number | null; quoteScore: number | null; gap: number | null };
  /** v13: how risk-on buying this market is (+ risk-on, − safe haven) */
  risk: number;
}

export interface FilterSummary {
  filter: FilterKind;
  label: string;
  /** strategies that picked it (on the first 70%) */
  chosenBy: number;
  /** strategies with enough trades to compare */
  compared: number;
  /** average change in R per trade vs no filter: first 70% / unseen 30% */
  inDeltaR: number;
  outDeltaR: number;
  /** % of compared strategies it improved on the unseen 30% */
  outBetterPct: number;
  /** % of the trades it keeps */
  keptPct: number;
  /** random entries + this filter: does the filter alone add anything? */
  random: { inAvgR: number; outAvgR: number; outN: number };
}

export interface PortfolioReport {
  from: number;
  to: number;
  picked: Array<{ id: string; name: string; tf: Timeframe; filter: FilterKind; inAvgR: number; inN: number; unseenN: number }>;
  oldPicked: number;
  /** the upgraded bot at several base risk levels */
  levels: PortfolioResult[];
  /** the bot as it was before v13 (no filters, flat 1% risk, no currency cap) on the same unseen weeks */
  old: PortfolioResult;
  note: string;
}

export interface FxReport {
  at: number;
  durationMs: number;
  feed: FeedStatus[];
  from: number | null;
  to: number | null;
  oosFrom: number | null;
  rows: Row[];
  markets: MarketNow[];
  paper: { since: number; rows: PaperRow[]; open: Trade[]; recent: Trade[] };
  note: string;
  strength?: StrengthNow;
  mood?: MoodNow;
  filters?: FilterSummary[];
  portfolio?: PortfolioReport | null;
  news?: NewsStudy | null;
}

export const FX_REPORT = 'fx:report';
export const FX_PAPER_SINCE = 'fx:paper:since';
export const FX_PORTFOLIO = 'fx:portfolio';
/** last hour's filter per strategy × timeframe (keeps near-ties from flipping) */
export const FX_FILTERS_CHOSEN = 'fx:filters:chosen';

const yieldNow = () => new Promise((r) => setImmediate(r));
const HOUR = 3_600_000;

/** Pure: judge one strategy × timeframe against the random yardstick. */
export function verdictFor(row: Pick<Row, 'inSample' | 'outSample' | 'all'>, randomAvgR: number | null): { verdict: Row['verdict']; why: string } {
  const o = row.outSample;
  const i = row.inSample;
  const beatsRandom = randomAvgR === null || row.all.avgR >= randomAvgR + 0.05;
  if (o.n < FX_CONFIG.minOosTrades) return { verdict: 'no', why: `only ${o.n} trades in the unseen last ${Math.round(FX_CONFIG.oosFraction * 100)}% (needs ${FX_CONFIG.minOosTrades})` };
  if (o.avgR > 0 && i.avgR > 0 && (o.pf ?? 99) >= 1.2 && beatsRandom) return { verdict: 'edge', why: `positive before AND after the split (out of sample ${o.avgR}R a trade, PF ${o.pf ?? '∞'}) and beats random` };
  if (o.avgR > 0 && (row.all.pf ?? 99) >= 1.1) return { verdict: 'maybe', why: `positive on unseen data (${o.avgR}R) but ${i.avgR <= 0 ? 'lost in the first part' : (o.pf ?? 99) < 1.2 ? 'too thin (PF under 1.2)' : 'not clearly better than random'}` };
  return { verdict: 'no', why: o.avgR <= 0 ? `loses on unseen data (${o.avgR}R a trade)` : 'too weak overall' };
}

/** Pure: does a strategy's first-70% record earn it a place in the bot (the honest whole-bot test)? */
export const pickedOnInSample = (s: RStats) => s.n >= FX_CONFIG.pick.minN && s.avgR >= FX_CONFIG.pick.minAvgR && (s.pf ?? 99) >= FX_CONFIG.pick.minPf;

/** Pure: how each filter did across all strategies, and on random entries. */
export function summarizeFilters(rows: ReadonlyArray<Pick<Row, 'id' | 'filter' | 'variants'>>): FilterSummary[] {
  const out: FilterSummary[] = [];
  for (const f of FILTERS) {
    if (f === 'none') continue;
    let compared = 0;
    let inD = 0;
    let outD = 0;
    let better = 0;
    let kept = 0;
    let keptN = 0;
    let outCompared = 0;
    for (const r of rows) {
      if (r.id === 'random') continue;
      const raw = r.variants.find((v) => v.filter === 'none');
      const v = r.variants.find((x) => x.filter === f);
      if (!raw || !v) continue;
      if (raw.allN > 0) {
        kept += v.allN / raw.allN;
        keptN++;
      }
      if (raw.inN < 30 || v.inN < 30) continue;
      compared++;
      inD += v.inAvgR - raw.inAvgR;
      if (raw.outN >= 15 && v.outN >= 15) {
        outCompared++;
        outD += v.outAvgR - raw.outAvgR;
        if (v.outAvgR > raw.outAvgR) better++;
      }
    }
    const rnd = rows.find((r) => r.id === 'random')?.variants.find((v) => v.filter === f);
    const r2 = (x: number) => Math.round(x * 100) / 100;
    out.push({
      filter: f,
      label: FILTER_LABEL[f],
      chosenBy: rows.filter((r) => r.id !== 'random' && r.filter === f).length,
      compared,
      inDeltaR: compared ? r2(inD / compared) : 0,
      outDeltaR: outCompared ? r2(outD / outCompared) : 0,
      outBetterPct: outCompared ? Math.round((better / outCompared) * 100) : 0,
      keptPct: keptN ? Math.round((kept / keptN) * 100) : 0,
      random: { inAvgR: rnd?.inAvgR ?? 0, outAvgR: rnd?.outAvgR ?? 0, outN: rnd?.outN ?? 0 },
    });
  }
  return out;
}

interface Series {
  inst: Instrument;
  tf: Timeframe;
  ctx: Ctx;
  env: FilterEnv;
}

export class ForexLab {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<FxReport | null> | null = null;
  /** set by index.ts: the account the bot auto-trades */
  practice: Practice | null = null;
  calendar: ForexCalendar | null = null;
  headlines: ForexHeadlines | null = null;
  /** strategies dropped by the bot because they lose in real time */
  dropped: string[] = [];
  botLog: Array<{ t: number; e: string }> = [];
  constructor(private readonly redis: Redis) {}

  start(): void {
    // keep the bot's decision log across restarts
    void this.redis
      .get('fx:bot:log')
      .then((raw) => {
        if (raw && !this.botLog.length) this.botLog = (JSON.parse(raw) as Array<{ t: number; e: string }>).slice(0, 100);
      })
      .catch(() => undefined);
    setTimeout(() => void this.run().catch(() => undefined), 45_000);
    // then 90 s after every full hour: the hourly candle has just closed (Yahoo / OANDA publish it within a minute)
    const next = () => {
      const now = Date.now();
      const at = Math.ceil((now - 90_000) / 3_600_000) * 3_600_000 + 90_000;
      this.timer = setTimeout(() => {
        void this.run().catch(() => undefined);
        next();
      }, Math.max(5_000, at - now));
    };
    next();
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
  isRunning(): boolean {
    return this.running !== null;
  }

  async last(): Promise<FxReport | null> {
    const raw = await this.redis.get(FX_REPORT).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FxReport;
    } catch {
      return null;
    }
  }

  run(refresh = true): Promise<FxReport | null> {
    if (this.running) return this.running;
    this.running = this.doRun(refresh).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(refresh: boolean): Promise<FxReport | null> {
    const t0 = Date.now();
    const feed: FeedStatus[] = [];
    if (refresh) {
      for (const inst of INSTRUMENTS) {
        feed.push({ ...(await refreshInstrument(this.redis, inst)), role: 'traded' });
        await new Promise((r) => setTimeout(r, 700));
      }
      for (const p of STRENGTH_PAIRS) {
        feed.push({ ...(await refreshSeries(this.redis, p.id, p.yahoo)), role: 'strength' });
        await new Promise((r) => setTimeout(r, 700));
      }
      for (const m of MOOD_SYMBOLS) {
        feed.push({ ...(await refreshSeries(this.redis, `mood:${m.id}`, m.yahoo, Date.now(), 800)), id: m.id, role: 'mood' });
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    let since = Number(await this.redis.get(FX_PAPER_SINCE).catch(() => null));
    if (!Number.isFinite(since) || since <= 0) {
      since = Date.now();
      await this.redis.set(FX_PAPER_SINCE, String(since)).catch(() => undefined);
    }

    // ── market read: strength (traded FX + crosses), mood ──
    const h1ById = new Map<string, Bar[]>();
    for (const inst of INSTRUMENTS) h1ById.set(inst.id, await loadBars(this.redis, inst.id));
    const strengthInput: Record<string, Bar[]> = {};
    for (const inst of INSTRUMENTS) if (inst.kind === 'fx') strengthInput[inst.id] = h1ById.get(inst.id)!;
    for (const p of STRENGTH_PAIRS) {
      const b = await loadBars(this.redis, p.id);
      strengthInput[p.id] = b;
      if (!refresh) feed.push({ id: p.id, role: 'strength', bars: b.length, firstT: b[0]?.t ?? null, lastT: b[b.length - 1]?.t ?? null, error: null });
    }
    const strength = buildStrength(strengthInput);
    await yieldNow();
    const moodInput: Partial<Record<(typeof MOOD_SYMBOLS)[number]['id'], Bar[]>> = {};
    for (const m of MOOD_SYMBOLS) {
      const b = await loadBars(this.redis, `mood:${m.id}`);
      if (b.length) moodInput[m.id] = b;
      if (!refresh) feed.push({ id: m.id, role: 'mood', bars: b.length, firstT: b[0]?.t ?? null, lastT: b[b.length - 1]?.t ?? null, error: null });
    }
    const mood = buildMood(moodInput);
    await yieldNow();

    // ── series + their filter readings ──
    const series: Series[] = [];
    const trendNow = new Map<string, { h1: number; h4: number; d1: number }>();
    let from = Infinity;
    let to = -Infinity;
    for (const inst of INSTRUMENTS) {
      const h1 = h1ById.get(inst.id)!;
      if (!refresh) feed.push({ id: inst.id, role: 'traded', bars: h1.length, firstT: h1[0]?.t ?? null, lastT: h1[h1.length - 1]?.t ?? null, error: null });
      if (h1.length < 400) continue;
      from = Math.min(from, h1[0]!.t);
      to = Math.max(to, h1[h1.length - 1]!.t);
      const h4bars = withEnd(to4h(h1), 4 * HOUR);
      const h4trend = trendSeries(h4bars);
      const daily = toDaily(h1);
      const dTrend = trendSeries(daily);
      const riskLong = riskOfLong(inst.id);
      for (const tf of FX_CONFIG.timeframes) {
        const bars = tf === '1h' ? h1 : h4bars.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
        if (bars.length < 400) continue;
        const barMin = tf === '1h' ? 60 : 240;
        const dts = decisionTimes(bars, barMin);
        const env: FilterEnv = {
          tf,
          gap: gapSeries(strength, inst.id, bars, barMin),
          h4: tf === '1h' ? alignTrend(dts, h4bars, h4trend) : new Int8Array(bars.length),
          d1: alignTrend(dts, daily, dTrend),
          mood: moodSeries(mood, bars, barMin),
          riskLong,
        };
        series.push({ inst, tf, ctx: buildCtx(bars, barMin, inst.id), env });
        if (tf === '1h') {
          const t1 = trendSeries(bars);
          trendNow.set(inst.id, { h1: t1[t1.length - 1] ?? 0, h4: env.h4[env.h4.length - 1] ?? 0, d1: env.d1[env.d1.length - 1] ?? 0 });
        }
      }
      await yieldNow();
    }
    if (!series.length) {
      const empty: FxReport = { at: Date.now(), durationMs: Date.now() - t0, feed, from: null, to: null, oosFrom: null, rows: [], markets: [], paper: { since, rows: [], open: [], recent: [] }, note: 'No forex candles yet. The server pulls them from Yahoo Finance; check the feed errors above.', strength: strengthNow(strength), mood: moodNow(mood) };
      await this.redis.set(FX_REPORT, JSON.stringify(empty)).catch(() => undefined);
      return empty;
    }
    const oosFrom = from + (1 - FX_CONFIG.oosFraction) * (to - from);
    let prevChosen: Record<string, FilterKind> = {};
    try {
      prevChosen = JSON.parse((await this.redis.get(FX_FILTERS_CHOSEN).catch(() => null)) ?? '{}') as Record<string, FilterKind>;
    } catch {
      prevChosen = {};
    }
    const rows: Row[] = [];
    const paperRows: PaperRow[] = [];
    const open: Trade[] = [];
    const recent: Trade[] = [];
    /** unseen trades of the strategies the whole-bot test picks (new = with filters, old = raw) */
    const poolNew: PTrade[] = [];
    const poolOld: PTrade[] = [];
    const pickedNew: PortfolioReport['picked'] = [];
    const pickedOld = new Set<string>();
    const weeks = Math.max(1, (to - from) / (7 * 86_400_000));
    for (const tf of FX_CONFIG.timeframes) {
      for (const s of STRATEGIES) {
        if (s.onlyHourly && tf !== '1h') continue;
        const byVariant = new Map<FilterKind, { trades: Trade[]; perPair: Row['pairs'] }>(FILTERS.map((f) => [f, { trades: [], perPair: [] }]));
        for (const se of series) {
          if (se.tf !== tf) continue;
          const sigs = signalsFor(se.ctx, s);
          for (const f of FILTERS) {
            const ts = simulate(se.inst, tf, se.ctx, s.id, sigs, allowFor(f, se.env));
            const v = byVariant.get(f)!;
            v.trades.push(...ts);
            v.perPair.push({ pair: se.inst.id, ...rStats(ts) });
          }
          await yieldNow();
        }
        const stats: VariantStats[] = FILTERS.map((f) => {
          const done = byVariant.get(f)!.trades.filter((t) => t.reason !== 'open');
          return { filter: f, all: rStats(done), inSample: rStats(done.filter((t) => t.entryT < oosFrom)), outSample: rStats(done.filter((t) => t.entryT >= oosFrom)) };
        });
        const chosen = s.id === 'random' ? 'none' : chooseFilter(stats, 40, prevChosen[`${s.id}:${tf}`]);
        const ch = stats.find((x) => x.filter === chosen)!;
        const v = byVariant.get(chosen)!;
        const done = v.trades.filter((t) => t.reason !== 'open');
        rows.push({
          id: s.id,
          name: s.name,
          family: s.family,
          desc: s.desc,
          tf,
          filter: chosen,
          variants: stats.map((x) => ({ filter: x.filter, inN: x.inSample.n, inAvgR: x.inSample.avgR, outN: x.outSample.n, outAvgR: x.outSample.avgR, outPf: x.outSample.pf, allN: x.all.n })),
          all: ch.all,
          inSample: ch.inSample,
          outSample: ch.outSample,
          tradesPerWeek: Math.round((done.length / weeks) * 10) / 10,
          risk: FX_CONFIG.riskLevelsPct.map((r) => equityCurve(done, r, FX_CONFIG.maxLeverage)),
          pairs: v.perPair.sort((a, b) => b.totalR - a.totalR),
          verdict: 'no',
          why: '',
        });
        const paper = v.trades.filter((t) => t.entryT >= since);
        const pDone = paper.filter((t) => t.reason !== 'open');
        const pOpen = paper.filter((t) => t.reason === 'open');
        paperRows.push({ id: s.id, name: s.name, tf, stats: rStats(pDone), risk1: equityCurve(pDone, 1, FX_CONFIG.maxLeverage), open: pOpen.length });
        open.push(...pOpen);
        recent.push(...pDone);
        // whole-bot test: picked on the first 70% only, traded on the unseen 30%
        if (s.id !== 'random') {
          const always = FX_CONFIG.botAlways.includes(s.id);
          if (always || pickedOnInSample(ch.inSample)) {
            const sf = stratFactorFromStats(ch.inSample.avgR, ch.inSample.pf);
            const unseen = done.filter((t) => t.entryT >= oosFrom);
            for (const t of unseen) poolNew.push({ pair: t.pair, side: t.side, entryT: t.entryT, exitT: t.exitT, r: t.r, stopPct: t.stopPct, strategy: t.strategy, tf: t.tf, sizeF: sf * volFactor(t.volRatio), prio: ch.inSample.avgR });
            pickedNew.push({ id: s.id, name: s.name, tf, filter: chosen, inAvgR: ch.inSample.avgR, inN: ch.inSample.n, unseenN: unseen.length });
          }
          const raw = stats.find((x) => x.filter === 'none')!;
          if (always || pickedOnInSample(raw.inSample)) {
            pickedOld.add(`${s.id}:${tf}`);
            for (const t of byVariant.get('none')!.trades) if (t.reason !== 'open' && t.entryT >= oosFrom) poolOld.push({ pair: t.pair, side: t.side, entryT: t.entryT, exitT: t.exitT, r: t.r, stopPct: t.stopPct, strategy: t.strategy, tf: t.tf, sizeF: 1 });
          }
        }
      }
    }
    for (const tf of FX_CONFIG.timeframes) {
      const rnd = rows.find((r) => r.tf === tf && r.id === 'random');
      for (const r of rows.filter((x) => x.tf === tf)) {
        if (r.id === 'random') {
          r.verdict = 'no';
          r.why = 'yardstick: random entries with the same costs';
          continue;
        }
        Object.assign(r, verdictFor(r, rnd ? rnd.all.avgR : null));
      }
    }
    const filters = summarizeFilters(rows);
    await this.redis.set(FX_FILTERS_CHOSEN, JSON.stringify(Object.fromEntries(rows.map((r) => [`${r.id}:${r.tf}`, r.filter])))).catch(() => undefined);
    rows.sort((a, b) => b.outSample.avgR * Math.min(1, b.outSample.n / 30) - a.outSample.avgR * Math.min(1, a.outSample.n / 30));
    paperRows.sort((a, b) => b.stats.totalR - a.stats.totalR);
    recent.sort((a, b) => b.exitT - a.exitT);
    open.sort((a, b) => b.entryT - a.entryT);
    await yieldNow();

    // ── whole-bot backtest on the unseen weeks ──
    let portfolio: PortfolioReport | null = null;
    if (poolNew.length || poolOld.length) {
      const base = { maxOpen: SIZING.maxOpen, leverage: SIZING.leverage, marginShare: SIZING.marginShare, from: oosFrom, to };
      const levels = FX_CONFIG.portfolioRiskPct.map((rp) => simulatePortfolio(poolNew, { ...base, label: `${rp}% risk`, baseRiskPct: rp, maxPerStrategy: SIZING.maxPerStrategy, prioritise: true, ccyCapPct: SIZING.ccyCapPct * rp, ddSizing: true, flatSizing: false }));
      const old = simulatePortfolio(poolOld, { ...base, label: 'before the upgrade', baseRiskPct: 1, maxPerStrategy: null, prioritise: false, ccyCapPct: null, ddSizing: false, flatSizing: true });
      portfolio = {
        from: oosFrom,
        to,
        picked: pickedNew,
        oldPicked: pickedOld.size,
        levels,
        old,
        note: `Strategies and their checks were picked on the first 70% of the history only; this is what the whole bot would have done on the last 30%, which it never saw: real spreads, max ${SIZING.maxOpen} trades at once (${SIZING.maxPerStrategy} per strategy), ${SIZING.leverage}× margin, the currency limit and the sizing rules.`,
      };
      await this.redis.set(FX_PORTFOLIO, JSON.stringify(portfolio)).catch(() => undefined);
    }
    await yieldNow();

    // ── live market view ──
    const gNow = strength.times.length - 1;
    const markets: MarketNow[] = [];
    for (const inst of INSTRUMENTS) {
      const se = series.find((x) => x.inst.id === inst.id && x.tf === '1h');
      if (!se) continue;
      const c = se.ctx;
      const n = c.bars.length;
      const last = c.bars[n - 1]!;
      const firing: MarketNow['firing'] = [];
      for (const x of series.filter((y) => y.inst.id === inst.id)) {
        for (const s of STRATEGIES) {
          if (s.id === 'random' || (s.onlyHourly && x.tf !== '1h')) continue;
          const sig = s.signal(x.ctx, x.ctx.bars.length - 1);
          if (!sig) continue;
          const f = rows.find((r) => r.id === s.id && r.tf === x.tf)?.filter ?? 'none';
          const why = blockReason(f, x.env, x.ctx.bars.length - 1, sig.side);
          firing.push({ id: s.id, name: s.name, tf: x.tf, side: sig.side, allowed: why === null, why });
        }
      }
      const e50 = c.ema50[n - 1]!;
      const e200 = c.ema200[n - 1]!;
      const isMetal = inst.kind === 'metal';
      const baseScore = isMetal ? null : scoreAt(strength, inst.id.slice(0, 3), gNow);
      const quoteScore = scoreAt(strength, isMetal ? 'USD' : inst.id.slice(3, 6), gNow);
      const gap = se.env.gap[n - 1]!;
      const fin = (x: number | null) => (x !== null && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
      markets.push({
        id: inst.id,
        label: inst.label,
        price: last.c,
        t: last.t,
        change24hPct: n > 24 ? Math.round((last.c / c.bars[n - 25]!.c - 1) * 10000) / 100 : 0,
        closes: c.close.slice(-72),
        trend: e50 > e200 * 1.0005 ? 'up' : e50 < e200 * 0.9995 ? 'down' : 'flat',
        rsi: Math.round(c.rsi14[n - 1]!),
        atrPips: Math.round((c.atr14[n - 1]! / inst.pip) * 10) / 10,
        firing,
        openPaper: open.filter((t) => t.pair === inst.id).length,
        bars: c.bars.slice(-150).map((b) => [b.t, b.o, b.h, b.l, b.c]),
        drawings: drawingsFor(c),
        mtf: trendNow.get(inst.id) ?? { h1: 0, h4: 0, d1: 0 },
        strength: { base: inst.id.slice(0, 3), quote: inst.id.slice(3, 6), baseScore: fin(baseScore), quoteScore: fin(quoteScore), gap: fin(gap) },
        risk: Math.round(riskOfLong(inst.id) * 10) / 10,
      });
    }

    // ── after big moves ──
    let news: NewsStudy | null = null;
    try {
      news = newsStudy(series.filter((x) => x.tf === '1h').map((x) => ({ pair: x.inst.id, ctx: x.ctx })), this.calendar?.history() ?? []);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'news study failed');
    }

    const edges = rows.filter((r) => r.verdict === 'edge').length;
    const filtered = rows.filter((r) => r.id !== 'random' && r.filter !== 'none').length;
    const report: FxReport = {
      at: Date.now(),
      durationMs: Date.now() - t0,
      feed,
      from,
      to,
      oosFrom,
      rows,
      markets,
      paper: { since, rows: paperRows, open: open.slice(0, 300), recent: recent.slice(0, 150) },
      note: `${rows.length} strategy × timeframe combinations on ${INSTRUMENTS.length} markets, each tried raw and with ${FILTERS.length - 1} filters (${filtered} kept a filter). ${edges} pass on unseen data. Many were tested at once, so expect a few to pass by luck: the paper results decide.`,
      strength: strengthNow(strength),
      mood: moodNow(mood),
      filters,
      portfolio,
      news,
    };
    await this.redis.set(FX_REPORT, JSON.stringify(report)).catch(() => undefined);
    if (this.practice) {
      // learn from its own results: a strategy with 12+ closed bot trades and a net loss is dropped; a winner gets a bit more
      const res = await this.practice.botResults().catch(() => ({} as Record<string, { n: number; pnlUsd: number }>));
      this.dropped = Object.entries(res).filter(([, v]) => v.n >= 12 && v.pnlUsd < 0).map(([k]) => k);
      const proven = new Set(Object.entries(res).filter(([, v]) => v.n >= 12 && v.pnlUsd > 0).map(([k]) => k));
      const chosenRows = rows.filter((x) => (x.verdict !== 'no' || FX_CONFIG.botAlways.includes(x.id)) && !this.dropped.includes(x.id));
      const chosen = new Set(chosenRows.map((x) => `${x.id}:${x.tf}`));
      const rowOf = new Map(chosenRows.map((x) => [`${x.id}:${x.tf}`, x]));
      const ev = await this.practice
        .syncBot(
          open.map((t) => {
            const row = rowOf.get(`${t.strategy}:${t.tf}`);
            const sizeF = (row ? stratFactorFromVerdict(row.verdict) : 1) * volFactor(t.volRatio) * (proven.has(t.strategy) ? 1.15 : 1);
            return { ref: `${t.strategy}:${t.tf}:${t.pair}:${t.entryT}`, strategy: t.strategy, tf: t.tf, pair: t.pair, side: t.side, entryT: t.entryT, stop: t.stop, target: t.target, chosen: chosen.has(`${t.strategy}:${t.tf}`), sizeF: Math.round(sizeF * 100) / 100, prio: row ? row.all.avgR : -1 };
          }),
          (pair) => this.calendar?.blockFor(pair) ?? this.headlines?.blockFor(pair) ?? null,
          Object.fromEntries(markets.map((m) => [m.id, m.atrPips * (INSTRUMENTS.find((i) => i.id === m.id)?.pip ?? 0)])),
        )
        .catch((err: Error) => [`bot sync failed: ${err.message}`]);
      for (const e of ev) this.botLog.unshift({ t: Date.now(), e });
      this.botLog = this.botLog.slice(0, 100);
      await this.redis.set('fx:bot:log', JSON.stringify(this.botLog)).catch(() => undefined);
      await this.redis.set('fx:bot:chosen', JSON.stringify([...chosen])).catch(() => undefined);
      await this.redis.set('fx:bot:dropped', JSON.stringify(this.dropped)).catch(() => undefined);
    }
    log.info({ rows: rows.length, edges, filtered, ms: report.durationMs }, 'forex lab run done');
    return report;
  }
}

