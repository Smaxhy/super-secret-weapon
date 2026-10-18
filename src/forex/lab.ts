/**
 * Forex lab (v12): every hour — refresh the candles, run EVERY strategy on every instrument on 1h and 4h bars,
 * and publish (a) the backtest over the full history with an in-sample / out-of-sample split and weekly results
 * at several risk levels, and (b) the PAPER results = trades opened after the lab first started (a true forward
 * test: those bars did not exist when the rules were written). Redis `fx:report`, `fx:paper:since`.
 * Nothing here places a real order. Live trading comes after paper proves something.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { refreshInstrument, loadBars, type FeedStatus } from './data';
import { equityCurve, rStats, runSeries, type RiskResult, type RStats } from './engine';
import { STRATEGIES, type Family } from './strategies';
import { buildCtx, to4h, type Ctx } from './ta';
import { INSTRUMENTS, type Timeframe, type Trade } from './types';

const log = moduleLogger('forex-lab');

export const FX_CONFIG = {
  timeframes: ['1h', '4h'] as Timeframe[],
  riskLevelsPct: [0.5, 1, 2, 5],
  /** leverage cap per trade (retail brokers 30–50×; on-chain perps allow more — we don't) */
  maxLeverage: 50,
  oosFraction: 0.3,
  refreshMinutes: 60,
  minOosTrades: 30,
};

export interface Row {
  id: string;
  name: string;
  family: Family;
  desc: string;
  tf: Timeframe;
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

export interface FxReport {
  at: number;
  durationMs: number;
  feed: FeedStatus[];
  from: number | null;
  to: number | null;
  oosFrom: number | null;
  rows: Row[];
  paper: { since: number; rows: PaperRow[]; open: Trade[]; recent: Trade[] };
  note: string;
}

export const FX_REPORT = 'fx:report';
export const FX_PAPER_SINCE = 'fx:paper:since';

const yieldNow = () => new Promise((r) => setImmediate(r));

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

export class ForexLab {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<FxReport | null> | null = null;
  constructor(private readonly redis: Redis) {}

  start(): void {
    setTimeout(() => void this.run().catch(() => undefined), 45_000);
    this.timer = setInterval(() => void this.run().catch(() => undefined), FX_CONFIG.refreshMinutes * 60_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
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
        feed.push(await refreshInstrument(this.redis, inst));
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    let since = Number(await this.redis.get(FX_PAPER_SINCE).catch(() => null));
    if (!Number.isFinite(since) || since <= 0) {
      since = Date.now();
      await this.redis.set(FX_PAPER_SINCE, String(since)).catch(() => undefined);
    }
    const series: Array<{ inst: (typeof INSTRUMENTS)[number]; tf: Timeframe; ctx: Ctx }> = [];
    let from = Infinity;
    let to = -Infinity;
    for (const inst of INSTRUMENTS) {
      const h1 = await loadBars(this.redis, inst.id);
      if (!refresh) feed.push({ id: inst.id, bars: h1.length, firstT: h1[0]?.t ?? null, lastT: h1[h1.length - 1]?.t ?? null, error: null });
      if (h1.length < 400) continue;
      from = Math.min(from, h1[0]!.t);
      to = Math.max(to, h1[h1.length - 1]!.t);
      for (const tf of FX_CONFIG.timeframes) {
        const bars = tf === '1h' ? h1 : to4h(h1);
        if (bars.length < 400) continue;
        series.push({ inst, tf, ctx: buildCtx(bars, tf === '1h' ? 60 : 240) });
      }
      await yieldNow();
    }
    if (!series.length) {
      const empty: FxReport = { at: Date.now(), durationMs: Date.now() - t0, feed, from: null, to: null, oosFrom: null, rows: [], paper: { since, rows: [], open: [], recent: [] }, note: 'No forex candles yet. The server pulls them from Yahoo Finance; check the feed errors above.' };
      await this.redis.set(FX_REPORT, JSON.stringify(empty)).catch(() => undefined);
      return empty;
    }
    const oosFrom = from + (1 - FX_CONFIG.oosFraction) * (to - from);
    const rows: Row[] = [];
    const paperRows: PaperRow[] = [];
    const open: Trade[] = [];
    const recent: Trade[] = [];
    for (const tf of FX_CONFIG.timeframes) {
      for (const s of STRATEGIES) {
        if (s.onlyHourly && tf !== '1h') continue;
        const trades: Trade[] = [];
        const perPair: Row['pairs'] = [];
        for (const se of series) {
          if (se.tf !== tf) continue;
          const ts = runSeries(se.inst, tf, se.ctx, s);
          trades.push(...ts);
          perPair.push({ pair: se.inst.id, ...rStats(ts) });
          await yieldNow();
        }
        const done = trades.filter((t) => t.reason !== 'open');
        const weeks = Math.max(1, (to - from) / (7 * 86_400_000));
        rows.push({
          id: s.id,
          name: s.name,
          family: s.family,
          desc: s.desc,
          tf,
          all: rStats(done),
          inSample: rStats(done.filter((t) => t.entryT < oosFrom)),
          outSample: rStats(done.filter((t) => t.entryT >= oosFrom)),
          tradesPerWeek: Math.round((done.length / weeks) * 10) / 10,
          risk: FX_CONFIG.riskLevelsPct.map((r) => equityCurve(done, r, FX_CONFIG.maxLeverage)),
          pairs: perPair.sort((a, b) => b.totalR - a.totalR),
          verdict: 'no',
          why: '',
        });
        const paper = trades.filter((t) => t.entryT >= since);
        const pDone = paper.filter((t) => t.reason !== 'open');
        const pOpen = paper.filter((t) => t.reason === 'open');
        paperRows.push({ id: s.id, name: s.name, tf, stats: rStats(pDone), risk1: equityCurve(pDone, 1, FX_CONFIG.maxLeverage), open: pOpen.length });
        open.push(...pOpen);
        recent.push(...pDone);
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
    rows.sort((a, b) => b.outSample.avgR * Math.min(1, b.outSample.n / 30) - a.outSample.avgR * Math.min(1, a.outSample.n / 30));
    paperRows.sort((a, b) => b.stats.totalR - a.stats.totalR);
    recent.sort((a, b) => b.exitT - a.exitT);
    open.sort((a, b) => b.entryT - a.entryT);
    const edges = rows.filter((r) => r.verdict === 'edge').length;
    const report: FxReport = {
      at: Date.now(),
      durationMs: Date.now() - t0,
      feed,
      from,
      to,
      oosFrom,
      rows,
      paper: { since, rows: paperRows, open: open.slice(0, 100), recent: recent.slice(0, 100) },
      note: `${rows.length} strategy × timeframe combinations on ${INSTRUMENTS.length} markets. ${edges} pass on unseen data. Many were tested at once, so expect a few to pass by luck: the paper results decide.`,
    };
    await this.redis.set(FX_REPORT, JSON.stringify(report)).catch(() => undefined);
    log.info({ rows: rows.length, edges, ms: report.durationMs }, 'forex lab run done');
    return report;
  }
}
