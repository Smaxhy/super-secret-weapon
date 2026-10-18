import { describe, expect, it } from 'vitest';
import { buildStrength, gapSeries, pairGap, scoreAt, strengthNow } from '../src/forex/strength';
import { alignTrend, decisionTimes, toDaily, trendSeries, withEnd } from '../src/forex/mtf';
import { buildMood, moodNow, moodSeries, riskOfLong } from '../src/forex/mood';
import { allowFor, blockReason, chooseFilter, type FilterEnv, type VariantStats } from '../src/forex/filters';
import { runSeries, signalsFor, simulate, volRatioAt, type RStats } from '../src/forex/engine';
import { addExposure, exposureBlock, monteCarlo, simulatePortfolio, type PTrade } from '../src/forex/portfolio';
import { shockDir, STRATEGIES, strategyById } from '../src/forex/strategies';
import { newsStudy } from '../src/forex/news-study';
import { currencyExposure, riskSummary } from '../src/forex/practice';
import { mergeHistory, type CalEvent } from '../src/forex/calendar';
import { pickedOnInSample, summarizeFilters } from '../src/forex/lab';
import { buildCtx, to4h } from '../src/forex/ta';
import { INSTRUMENTS, type Bar } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 6); // Monday
const EUR = INSTRUMENTS[0]!;

/** hourly bars with a steady drift per hour (log), small noise */
function trend(n: number, start: number, driftPerBar: number, seed = 3, t0 = T0): Bar[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: Bar[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o * Math.exp(driftPerBar + (rnd() - 0.5) * 0.0006);
    out.push({ t: t0 + i * H, o, h: Math.max(o, c) * 1.0003, l: Math.min(o, c) * 0.9997, c });
    px = c;
  }
  return out;
}
const st = (n: number, avgR: number, pf: number | null = 1.3): RStats => ({ n, winPct: 50, avgR, medianR: 0, pf, totalR: n * avgR, maxDdR: 1 });

describe('currency strength meter', () => {
  it('ranks a currency that rises against everything as the strongest, causally', () => {
    const pairs: Record<string, Bar[]> = {
      EURUSD: trend(400, 1.1, 0.0004, 1),
      EURJPY: trend(400, 160, 0.0004, 2),
      EURGBP: trend(400, 0.85, 0.0004, 3),
      GBPUSD: trend(400, 1.25, 0, 4),
      USDJPY: trend(400, 150, 0, 5),
    };
    const book = buildStrength(pairs);
    const now = strengthNow(book);
    expect(now.ccys[0]!.ccy).toBe('EUR');
    expect(now.ccys[0]!.score).toBeGreaterThan(0.5);
    const g = book.times.length - 1;
    expect(pairGap(book, 'EURUSD', g)).toBeGreaterThan(0);
    expect(pairGap(book, 'XAUUSD', g)).toBeCloseTo(-scoreAt(book, 'USD', g), 6);
    // no peeking: changing bars after hour k leaves every value at or before k unchanged
    const k = 250;
    const later = Object.fromEntries(Object.entries(pairs).map(([id, b]) => [id, b.map((x, i) => (i > k ? { ...x, c: x.c * 1.2, h: x.h * 1.2, l: x.l * 1.2 } : x))]));
    const b2 = buildStrength(later);
    for (let i = 130; i <= k; i++) expect(scoreAt(b2, 'EUR', i)).toBeCloseTo(scoreAt(book, 'EUR', i), 9);
    // per-bar series: a 1h bar reads the value of its own hour
    const gs = gapSeries(book, 'EURUSD', pairs.EURUSD!, 60);
    expect(gs[300]).toBeCloseTo(pairGap(book, 'EURUSD', 300), 9);
  });
});

describe('bigger-chart trend', () => {
  it('daily bars run 22:00 → 22:00 UTC and drop weekend slivers', () => {
    // Sunday 21:00 UTC → Wednesday: first 1h of Sunday 21:00 is a sliver (1 bar) and is dropped
    const start = Date.UTC(2025, 0, 5, 21);
    const bars = trend(24 * 3 + 1, 1.1, 0, 7, start);
    const d = toDaily(bars);
    expect(d[0]!.t).toBe(Date.UTC(2025, 0, 5, 22));
    expect(d[0]!.end - d[0]!.t).toBe(24 * H);
    expect(d.every((x) => new Date(x.t).getUTCHours() === 22)).toBe(true);
  });
  it('a smaller bar only sees bigger bars that had already finished', () => {
    const h1 = trend(24 * 120, 1.1, 0.0003, 9);
    const daily = toDaily(h1);
    const tr = trendSeries(daily);
    expect(tr[tr.length - 1]).toBe(1);
    const dts = decisionTimes(h1, 60);
    const al = alignTrend(dts, daily, tr);
    // every aligned value comes from a day that ended at or before the decision
    let k = -1;
    for (let i = 0; i < h1.length; i++) {
      while (k + 1 < daily.length && daily[k + 1]!.end <= dts[i]!) k++;
      expect(al[i]).toBe(k >= 0 ? tr[k]! : 0);
    }
    const h4 = withEnd(to4h(h1), 4 * H);
    expect(h4[0]!.end - h4[0]!.t).toBe(4 * H);
    expect(trendSeries(h4)[h4.length - 1]).toBe(1);
  });
});

describe('market mood', () => {
  it('stocks up + fear down = risk-on; AUD is a risk currency, JPY a haven', () => {
    const spx = trend(200, 6000, 0.0008, 11);
    const vix = trend(200, 20, -0.002, 12);
    const book = buildMood({ SPX: spx, VIX: vix });
    const now = moodNow(book);
    expect(now.label).toBe('risk-on');
    expect(now.score!).toBeGreaterThan(0.5);
    const fall = buildMood({ SPX: trend(200, 6000, -0.0008, 13), VIX: trend(200, 20, 0.002, 14) });
    expect(moodNow(fall).label).toBe('risk-off');
    expect(riskOfLong('AUDJPY')).toBeGreaterThan(1.5);
    expect(riskOfLong('USDJPY')).toBeGreaterThan(0);
    expect(riskOfLong('XAUUSD')).toBeLessThan(0);
    // series reads an hour that has closed by the bar's close
    const fx = trend(200, 1.1, 0, 15);
    const ms = moodSeries(book, fx, 60);
    expect(Number.isFinite(ms[150]!)).toBe(true);
  });
});

describe('filters', () => {
  const env = (o: Partial<FilterEnv> = {}): FilterEnv => ({ tf: '1h', gap: new Float64Array([0.5]), h4: Int8Array.from([1]), d1: Int8Array.from([0]), mood: new Float64Array([-1]), riskLong: 1.5, ...o });
  it('veto rules', () => {
    expect(blockReason('strength', env(), 0, 1)).toBeNull();
    expect(blockReason('strength', env(), 0, -1)).toMatch(/stronger/);
    expect(blockReason('strength', env({ gap: new Float64Array([NaN]) }), 0, -1)).toBeNull(); // unknown never blocks
    expect(blockReason('mtf', env(), 0, 1)).toBeNull();
    expect(blockReason('mtf', env(), 0, -1)).toMatch(/bigger chart/);
    expect(blockReason('mtf', env({ d1: Int8Array.from([-1]) }), 0, 1)).toMatch(/bigger chart/);
    expect(blockReason('mtf', env({ tf: '4h', d1: Int8Array.from([1]) }), 0, 1)).toBeNull();
    // risk-off market: buying a risk currency (AUD/JPY-like, riskLong 1.5) is blocked, selling it is fine
    expect(blockReason('mood', env(), 0, 1)).toMatch(/mood/);
    expect(blockReason('mood', env(), 0, -1)).toBeNull();
    expect(blockReason('all', env(), 0, 1)).toMatch(/mood/);
    expect(allowFor('none', env())).toBeUndefined();
  });
  it('picks a filter on the first 70% only when it clearly beats raw and keeps enough trades', () => {
    const v = (f: VariantStats['filter'], inN: number, inR: number): VariantStats => ({ filter: f, all: st(inN, inR), inSample: st(inN, inR), outSample: st(10, 0) });
    expect(chooseFilter([v('none', 400, 0.02), v('mtf', 200, 0.15), v('strength', 30, 0.9)])).toBe('mtf');
    expect(chooseFilter([v('none', 400, 0.05), v('mtf', 380, 0.052)])).toBe('none'); // not a clear gain
    expect(chooseFilter([v('none', 400, 0.02), v('strength', 35, 0.9)])).toBe('none'); // too few trades left
    // last hour's pick stays through a near-tie, but loses to a clearly better one
    expect(chooseFilter([v('none', 400, 0.02), v('mtf', 200, 0.15), v('strength', 200, 0.16)], 40, 'mtf')).toBe('mtf');
    expect(chooseFilter([v('none', 400, 0.02), v('mtf', 200, 0.15), v('strength', 200, 0.16)])).toBe('strength');
    expect(chooseFilter([v('none', 400, 0.02), v('mtf', 200, 0.15), v('strength', 200, 0.4)], 40, 'mtf')).toBe('strength');
  });
  it('the engine: a filter only vetoes entries; precomputed signals give the same trades', () => {
    let s = 5;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const bars: Bar[] = [];
    let px = 1.1;
    for (let i = 0; i < 3000; i++) {
      const o = px;
      const c = o + Math.sin(i / 300) * 0.0001 + (rnd() - 0.5) * 0.002;
      bars.push({ t: T0 + i * H, o, h: Math.max(o, c) + rnd() * 0.0008, l: Math.min(o, c) - rnd() * 0.0008, c });
      px = c;
    }
    const c = buildCtx(bars, 60, 'EURUSD');
    for (const id of ['ema_cross', 'rsi2', 'donchian20', 'tsmom']) {
      const strat = strategyById(id)!;
      const raw = runSeries(EUR, '1h', c, strat);
      expect(simulate(EUR, '1h', c, id, signalsFor(c, strat))).toEqual(raw);
      expect(runSeries(EUR, '1h', c, strat, () => true)).toEqual(raw);
      expect(runSeries(EUR, '1h', c, strat, () => false)).toHaveLength(0);
      const longOnly = runSeries(EUR, '1h', c, strat, (_i, side) => side === 1);
      expect(longOnly.every((t) => t.side === 1)).toBe(true);
    }
    const vr = volRatioAt(c, 1000);
    expect(vr).toBeGreaterThan(0.3);
    expect(vr).toBeLessThan(3);
  });
});

describe('news drift', () => {
  function shockMarket(cont: boolean): Bar[] {
    const bars: Bar[] = [];
    let px = 1.1;
    for (let i = 0; i < 400; i++) {
      let o = px;
      let c = o + (i % 2 ? 0.0002 : -0.0002);
      let h = Math.max(o, c) + 0.0002;
      let l = Math.min(o, c) - 0.0002;
      if (i === 300) {
        // a big up candle closing at its high
        c = o + 0.004;
        h = c + 0.0001;
        l = o - 0.0001;
      } else if (i > 300 && i < 330) {
        const step = cont ? 0.0004 : -0.0004;
        o = px;
        c = o + step;
        h = Math.max(o, c) + 0.0001;
        l = Math.min(o, c) - 0.0001;
      }
      bars.push({ t: T0 + i * H, o, h, l, c });
      px = c;
    }
    return bars;
  }
  it('spots a shock candle and the drift strategy follows it', () => {
    const c = buildCtx(shockMarket(true), 60, 'EURUSD');
    expect(shockDir(c, 300)).toBe(1);
    expect(shockDir(c, 299)).toBe(0);
    const sig = strategyById('news_drift')!.signal(c, 300);
    expect(sig?.side).toBe(1);
    expect(STRATEGIES.filter((s) => s.family === 'news').map((s) => s.id).sort()).toEqual(['news_drift', 'news_fade']);
  });
  it('study: continuation is positive when the move kept going, negative when it reversed', () => {
    const up = newsStudy([{ pair: 'EURUSD', ctx: buildCtx(shockMarket(true), 60, 'EURUSD') }]);
    expect(up.shocks).toBeGreaterThanOrEqual(1);
    expect(up.overall.avgAtr[1]!).toBeGreaterThan(0);
    const down = newsStudy([{ pair: 'EURUSD', ctx: buildCtx(shockMarket(false), 60, 'EURUSD') }]);
    expect(down.overall.avgAtr[2]!).toBeLessThan(0);
    // an event in that hour tags the shock by kind
    const ev: CalEvent = { t: T0 + 300 * H + 30 * 60_000, ccy: 'USD', title: 'CPI m/m', impact: 'High', forecast: '', previous: '' };
    const tagged = newsStudy([{ pair: 'EURUSD', ctx: buildCtx(shockMarket(true), 60, 'EURUSD') }], [ev]);
    expect(tagged.byEvent.find((x) => x.key === 'cpi')?.n).toBe(1);
    expect(tagged.recent[0]!.event).toMatch(/CPI/);
  });
  it('calendar history keeps high-impact releases and speeches, deduped', () => {
    const now = T0 + 400 * 86_400_000;
    const e = (t: number, impact: CalEvent['impact'], title: string): CalEvent => ({ t, ccy: 'USD', title, impact, forecast: '', previous: '' });
    const h = mergeHistory([e(now - 86_400_000, 'High', 'CPI')], [e(now - 86_400_000, 'High', 'CPI'), e(now, 'Low', 'Housing'), e(now, 'Medium', 'Fed Chair Powell Speaks'), e(now - 500 * 86_400_000, 'High', 'Old')], now);
    expect(h.map((x) => x.title)).toEqual(['CPI', 'Fed Chair Powell Speaks']);
  });
});

describe('one bet per currency + safer sizing + whole-bot backtest', () => {
  it('exposure: a third dollar trade is blocked, a trade that reduces it is not', () => {
    const exp = {};
    addExposure(exp, 'EURUSD', 1, 1); // long EUR, short USD
    addExposure(exp, 'GBPUSD', 1, 1); // short USD again
    expect(exposureBlock(exp, 'AUDUSD', 1, 1, 2.2)).toBe('USD');
    expect(exposureBlock(exp, 'USDJPY', 1, 1, 2.2)).toBeNull(); // long USD reduces the dollar short
    expect(exposureBlock(exp, 'XAUUSD', 1, 0.2, 2.2)).toBeNull(); // small enough to stay under the cap
  });
  const tr = (k: number, o: Partial<PTrade> = {}): PTrade => ({ pair: 'EURUSD', side: 1, entryT: T0 + k * 24 * H, exitT: T0 + k * 24 * H + 6 * H, r: 1, stopPct: 0.3, strategy: 's', tf: '1h', sizeF: 1, ...o });
  const opts = { label: 't', baseRiskPct: 1, maxOpen: 8, maxPerStrategy: 3, prioritise: true, ccyCapPct: 2.2, leverage: 30, marginShare: 0.25, ddSizing: true, flatSizing: false };
  it('caps per currency and per strategy, gives free slots to the best-tested signal first', () => {
    // 4 USD-short trades at once: the cap lets 2 in
    const same = [tr(0), tr(0, { pair: 'GBPUSD' }), tr(0, { pair: 'AUDUSD' }), tr(0, { pair: 'NZDUSD' })];
    const r = simulatePortfolio(same, opts);
    expect(r.trades).toBe(2);
    expect(r.skipped.ccy).toBe(2);
    // per-strategy cap
    const many = ['EURJPY', 'GBPJPY', 'XAUUSD', 'XAGUSD', 'EURGBP'].map((p, k) => tr(0, { pair: p, side: k % 2 ? -1 : 1 }));
    expect(simulatePortfolio(many, { ...opts, ccyCapPct: null }).skipped.strategy).toBe(2);
    // one slot: the higher-priority signal wins
    const pr = simulatePortfolio([tr(0, { strategy: 'a', prio: 0.1, r: -1 }), tr(0, { strategy: 'b', prio: 0.5, r: 2 })], { ...opts, maxOpen: 1 });
    expect(pr.finalX).toBeGreaterThan(1);
  });
  it('smaller trades after a drop; weekly / monthly stats over the whole window; Monte Carlo is repeatable', () => {
    const losers = Array.from({ length: 30 }, (_, k) => tr(k, { r: -1, pair: k % 2 ? 'EURUSD' : 'USDJPY' }));
    const withDd = simulatePortfolio(losers, opts);
    const flat = simulatePortfolio(losers, { ...opts, ddSizing: false, flatSizing: true });
    expect(withDd.finalX).toBeGreaterThan(flat.finalX);
    const win = Array.from({ length: 60 }, (_, k) => tr(k, { r: k % 3 ? 1.5 : -1 }));
    const r = simulatePortfolio(win, { ...opts, from: T0, to: T0 + 120 * 86_400_000 });
    expect(r.weeks).toBeGreaterThanOrEqual(17);
    expect(r.months).toBeGreaterThanOrEqual(4);
    expect(r.finalX).toBeGreaterThan(1);
    expect(r.mc).not.toBeNull();
    const weekly = [2, -1, 3, 1, -2, 4, 0, 1, -1, 2];
    expect(monteCarlo(weekly, 500, 7)).toEqual(monteCarlo(weekly, 500, 7));
    expect(monteCarlo(weekly.slice(0, 5))).toBeNull();
  });
  it('bot account exposure from real positions', () => {
    const mids = { EURUSD: 1.1, GBPUSD: 1.25, USDJPY: 150 };
    const open = [
      { pair: 'EURUSD', side: 1 as const, units: 10_000, entry: 1.1, stop: 1.09 }, // risk $100
      { pair: 'GBPUSD', side: 1 as const, units: 10_000, entry: 1.25, stop: 1.26 }, // stop above entry: profit locked, no risk
    ];
    const exp = currencyExposure(open, mids, 10_000);
    expect(exp.EUR).toBeCloseTo(1);
    expect(exp.USD).toBeCloseTo(-1);
    expect(exp.GBP ?? 0).toBeCloseTo(0);
    const rs = riskSummary({ open, peakUsd: 12_000, startUsd: 10_000 }, mids, 10_000);
    expect(rs.ddPct).toBeCloseTo(16.7, 0);
    expect(rs.ddFactor).toBe(0.5);
    expect(rs.openRiskPct).toBeCloseTo(1);
  });
  it('lab helpers: picking on the first 70% and the filter summary', () => {
    expect(pickedOnInSample(st(50, 0.1, 1.3))).toBe(true);
    expect(pickedOnInSample(st(30, 0.1, 1.3))).toBe(false);
    expect(pickedOnInSample(st(80, 0.01, 1.3))).toBe(false);
    const vr = (filter: 'none' | 'mtf', inR: number, outR: number, n = 100) => ({ filter, inN: n, inAvgR: inR, outN: n / 2, outAvgR: outR, outPf: 1.2, allN: n * 1.5 });
    const rows = [
      { id: 'a', filter: 'mtf' as const, variants: [vr('none', 0, 0), vr('mtf', 0.2, 0.1, 50)] },
      { id: 'b', filter: 'none' as const, variants: [vr('none', 0.1, 0.1), vr('mtf', 0.1, 0.2, 60)] },
      { id: 'random', filter: 'none' as const, variants: [vr('none', -0.1, -0.1), vr('mtf', 0.05, 0.02)] },
    ];
    const sm = summarizeFilters(rows).find((x) => x.filter === 'mtf')!;
    expect(sm.chosenBy).toBe(1);
    expect(sm.compared).toBe(2);
    expect(sm.inDeltaR).toBeCloseTo(0.1);
    expect(sm.outDeltaR).toBeCloseTo(0.1);
    expect(sm.outBetterPct).toBe(100);
    expect(sm.random.outAvgR).toBe(0.02);
  });
});
