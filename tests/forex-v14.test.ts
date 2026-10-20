import { describe, expect, it } from 'vitest';
import { runSeries, simulate, signalsFor, spreadMult } from '../src/forex/engine';
import { applyExit, EXITS } from '../src/forex/exits';
import { allowFor, blockReason, type FilterEnv } from '../src/forex/filters';
import { lastWeekdayOfMonth, pairZ, STRATEGIES, strategyById, styleOf, type Strategy } from '../src/forex/strategies';
import { buildCtx, efficiencyRatio, type Ctx, type CtxExt } from '../src/forex/ta';
import { auc, JUDGE_FEATURES, trainJudge, type JudgeRow } from '../src/forex/judge';
import { mtdSeries, strengthRanks, z24Series } from '../src/forex/intermarket';
import { walkForward, type WTrade } from '../src/forex/portfolio';
import { newAccount, tick, type Quote } from '../src/forex/practice';
import { marketClock } from '../src/forex/calendar';
import { buildStrength } from '../src/forex/strength';
import { INSTRUMENTS, type Bar, type Signal } from '../src/forex/types';
import { VENUE_FEES } from '../src/forex/venue-fees';
// v26: these tests pin exact R / USD numbers of other features — the venue fee is tested on its own (forex-venue-fees)
VENUE_FEES.on = false;

const H = 3_600_000;
const EUR = INSTRUMENTS[0]!;
const SPREAD = EUR.spreadPips * EUR.pip;

/** hourly times from t0 skipping the forex weekend (Fri 21:00 → Sun 22:00 UTC) */
function tradingHours(n: number, t0: number): number[] {
  const out: number[] = [];
  for (let t = t0; out.length < n; t += H) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const h = d.getUTCHours();
    if ((dow === 5 && h >= 21) || dow === 6 || (dow === 0 && h < 22)) continue;
    out.push(t);
  }
  return out;
}
const flatBar = (t: number, px: number): Bar => ({ t, o: px, h: px + 0.0001, l: px - 0.0001, c: px });
const once = (at: number, sig: Signal): Strategy => ({ id: 'x', name: 'x', family: 'control', desc: '', signal: (_c, i) => (i === at ? sig : null) });

describe('engine realism (v14)', () => {
  it('charges 3× the spread at the rollover hour and 4× right after the weekend', () => {
    expect(spreadMult(Date.UTC(2025, 0, 6, 21), Date.UTC(2025, 0, 6, 20))).toBe(3);
    expect(spreadMult(Date.UTC(2025, 0, 6, 10), Date.UTC(2025, 0, 6, 9))).toBe(1);
    expect(spreadMult(Date.UTC(2025, 0, 12, 22), Date.UTC(2025, 0, 10, 20))).toBe(4);
    // a fill on the 21:00 bar costs 1 extra spread vs the plain model
    const t0 = Date.UTC(2025, 0, 6);
    const bars = Array.from({ length: 300 }, (_, i) => flatBar(t0 + i * H, 1.1));
    const s = once(260, { side: 1, stop: 1.095, target: 1.12, maxBars: 3 }); // fills on bar 261 = 21:00 UTC
    const c = buildCtx(bars, 60, 'EURUSD');
    const real = runSeries(EUR, '1h', c, s);
    const plain = runSeries(EUR, '1h', c, s, undefined, { sessionSpreads: false, weekendPause: true });
    expect(real[0]!.entry - plain[0]!.entry).toBeCloseTo(SPREAD, 8);
  });

  function weekendMarket(sundayOpen: number, after: number[]) {
    const times = tradingHours(400, Date.UTC(2024, 11, 30));
    let g = -1;
    for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! > 30 * H && i > 220) {
      g = i;
      break;
    }
    const bars = times.map((t, i) => {
      if (i < g) return flatBar(t, 1.1);
      if (i === g) return { t, o: sundayOpen, h: Math.max(sundayOpen, after[0] ?? sundayOpen) + 0.0001, l: Math.min(sundayOpen, after[0] ?? sundayOpen) - 0.0001, c: after[0] ?? sundayOpen };
      const px = after[Math.min(after.length - 1, i - g)] ?? 1.1;
      return flatBar(t, px);
    });
    return { bars, g };
  }

  it('weekend pause: a gap through the stop ends the trade at Friday’s close instead of the gap price', () => {
    const { bars, g } = weekendMarket(1.09, [1.09]);
    const s = once(g - 10, { side: 1, stop: 1.095, target: 1.12 });
    const c = buildCtx(bars, 60, 'EURUSD');
    const paused = runSeries(EUR, '1h', c, s);
    const held = runSeries(EUR, '1h', c, s, undefined, { weekendPause: false, sessionSpreads: true });
    expect(paused[0]!.reason).toBe('weekend');
    expect(paused[0]!.r).toBeGreaterThan(-0.1); // only costs
    expect(held[0]!.reason).toBe('stop');
    expect(held[0]!.r).toBeLessThan(-1.9); // the gap went through the stop
  });

  it('weekend pause: otherwise it re-enters after the gap and keeps the original 1R', () => {
    const up = [1.098, 1.1, 1.105, 1.11, 1.115, 1.121];
    const { bars, g } = weekendMarket(1.098, up);
    const s = once(g - 10, { side: 1, stop: 1.095, target: 1.12 });
    const c = buildCtx(bars, 60, 'EURUSD');
    const paused = runSeries(EUR, '1h', c, s);
    const held = runSeries(EUR, '1h', c, s, undefined, { weekendPause: false, sessionSpreads: true });
    expect(paused[0]!.reason).toBe('target');
    expect(held[0]!.reason).toBe('target');
    // flat over the weekend, it dodged the 20-pip gap down and re-bought lower: more R than holding through
    expect(paused[0]!.r).toBeGreaterThan(held[0]!.r + 0.3);
  });

  it('break-even and half-off at +1R', () => {
    const t0 = Date.UTC(2025, 0, 6);
    const bars = Array.from({ length: 300 }, (_, i) => flatBar(t0 + i * H, 1.1));
    // bar 252 reaches +1R (1.1050) without touching break-even; bar 254 falls back to 1.0990
    bars[252] = { t: bars[252]!.t, o: 1.1, h: 1.1061, l: 1.1012, c: 1.104 };
    bars[253] = flatBar(bars[253]!.t, 1.104);
    bars[254] = { t: bars[254]!.t, o: 1.104, h: 1.104, l: 1.099, c: 1.099 };
    const c = buildCtx(bars, 60, 'EURUSD');
    const base: Signal = { side: 1, stop: 1.095, target: 1.12 };
    const be = runSeries(EUR, '1h', c, once(249, { ...base, beAtR: 1 }));
    expect(be[0]!.reason).toBe('breakeven');
    expect(Math.abs(be[0]!.r)).toBeLessThan(0.05);
    const sc = runSeries(EUR, '1h', c, once(249, { ...base, scaleAtR: 1, scaleFrac: 0.5 }));
    expect(sc[0]!.scaled).toBe(true);
    expect(sc[0]!.r).toBeGreaterThan(0.45);
    expect(sc[0]!.r).toBeLessThan(0.55);
    const plain = runSeries(EUR, '1h', c, once(249, base));
    expect(plain[0]!.reason).not.toBe('breakeven');
  });

  it('exit variants transform the signal', () => {
    const t0 = Date.UTC(2025, 0, 6);
    const c = buildCtx(Array.from({ length: 300 }, (_, i) => flatBar(t0 + i * H, 1.1)), 60, 'EURUSD');
    const sig: Signal = { side: 1, stop: 1.095, target: 1.11, maxBars: 50 };
    expect(applyExit(sig, 'designed', c, 250)).toBe(sig);
    expect(applyExit(sig, 'breakeven', c, 250)!.beAtR).toBe(1);
    expect(applyExit(sig, 'scale', c, 250)!.scaleAtR).toBe(1);
    expect(applyExit(sig, 'tight', c, 250)!.target!).toBeCloseTo(1.106, 6);
    expect(applyExit({ ...sig, target: null }, 'tight', c, 250)!.target!).toBeCloseTo(1.1075, 6);
    const run = applyExit(sig, 'runner', c, 250)!;
    expect(run.target).toBeNull();
    expect(run.trailAtr).toBe(2.5);
    expect(applyExit(sig, 'quick', c, 250)!.maxBars).toBe(12);
    expect(applyExit(null, 'scale', c, 250)).toBeNull();
    expect(EXITS[0]).toBe('designed');
  });
});

describe('regime check + new strategies', () => {
  it('efficiency ratio: a straight line is 1, a zig-zag is near 0', () => {
    const line = Array.from({ length: 40 }, (_, i) => 1 + i * 0.001);
    const zig = Array.from({ length: 40 }, (_, i) => 1 + (i % 2) * 0.001);
    expect(efficiencyRatio(line)[30]).toBeCloseTo(1, 6);
    expect(efficiencyRatio(zig)[30]).toBeLessThan(0.1);
  });
  it('regime: trend strategies need a trending market, fade strategies a choppy one', () => {
    const env = (er: number): FilterEnv => ({ tf: '1h', gap: new Float64Array([NaN]), h4: Int8Array.from([0]), d1: Int8Array.from([0]), mood: new Float64Array([NaN]), riskLong: 0, er: new Float64Array([er]) });
    expect(blockReason('regime', env(0.5), 0, 1, 'trend')).toBeNull();
    expect(blockReason('regime', env(0.1), 0, 1, 'trend')).toMatch(/choppy/);
    expect(blockReason('regime', env(0.1), 0, 1, 'revert')).toBeNull();
    expect(blockReason('regime', env(0.5), 0, 1, 'revert')).toMatch(/trending/);
    expect(allowFor('regime', env(0.1), 'neutral')).toBeUndefined();
    expect(allowFor('regime', env(0.1), 'pullback')).toBeUndefined();
    expect(styleOf(strategyById('supertrend')!)).toBe('trend');
    expect(styleOf(strategyById('bb_reversion')!)).toBe('revert');
    expect(styleOf(strategyById('rsi2')!)).toBe('pullback');
    expect(styleOf(strategyById('london_breakout')!)).toBe('neutral');
  });

  function withExt(n: number, pair: string, set: (e: CtxExt) => void, base = 1.3): Ctx {
    const t0 = Date.UTC(2025, 0, 6);
    const bars = Array.from({ length: n }, (_, i) => flatBar(t0 + i * H, base));
    const c = buildCtx(bars, 60, pair);
    const nan = () => new Float64Array(n).fill(NaN);
    const e: CtxExt = { gap: nan(), rankBase: nan(), rankQuote: nan(), zOil: nan(), zYield: nan(), zStocks: nan(), zDollar: nan(), spxMtd: nan() };
    set(e);
    c.ext = e;
    return c;
  }

  it('currency momentum fires when the pair becomes strongest vs weakest', () => {
    const c = withExt(300, 'EURUSD', (e) => {
      e.rankBase.fill(3);
      e.rankQuote.fill(4);
      for (let i = 260; i < 300; i++) {
        e.rankBase[i] = 0;
        e.rankQuote[i] = 7;
      }
    }, 1.1);
    const s = strategyById('ccy_momentum')!;
    expect(s.signal(c, 260)?.side).toBe(1);
    expect(s.signal(c, 261)).toBeNull(); // only when it newly lines up
    expect(s.signal(withExt(300, 'EURUSD', () => undefined, 1.1), 260)).toBeNull(); // no data, no signal
  });

  it('intermarket catch-up: oil jumps and USD/CAD has not moved → sell USD/CAD', () => {
    const c = withExt(300, 'USDCAD', (e) => {
      e.zOil.fill(0.2);
      e.zOil[270] = 1.8;
    });
    expect(Number.isFinite(pairZ(c, 270))).toBe(true);
    expect(strategyById('oil_cad')!.signal(c, 270)?.side).toBe(-1);
    expect(strategyById('oil_cad')!.signal(c, 271)).toBeNull();
    const j = withExt(300, 'USDJPY', (e) => {
      e.zYield.fill(0);
      e.zYield[270] = -2;
    }, 150);
    expect(strategyById('yield_jpy')!.signal(j, 270)?.side).toBe(-1);
  });

  it('month-end flow: last weekday, 14:00 UTC, after a strong S&P month → sell dollars', () => {
    expect(lastWeekdayOfMonth(Date.UTC(2025, 0, 31, 13))).toBe(true); // Fri 31 Jan
    expect(lastWeekdayOfMonth(Date.UTC(2025, 0, 30, 13))).toBe(false);
    expect(lastWeekdayOfMonth(Date.UTC(2025, 1, 28, 13))).toBe(true); // Fri 28 Feb
    const t0 = Date.UTC(2025, 0, 20);
    const bars = Array.from({ length: 300 }, (_, i) => flatBar(t0 + i * H, 1.05));
    const c = buildCtx(bars, 60, 'EURUSD');
    const n = bars.length;
    c.ext = { gap: new Float64Array(n), rankBase: new Float64Array(n), rankQuote: new Float64Array(n), zOil: new Float64Array(n), zYield: new Float64Array(n), zStocks: new Float64Array(n), zDollar: new Float64Array(n), spxMtd: new Float64Array(n).fill(3) };
    const i = bars.findIndex((b) => b.t === Date.UTC(2025, 0, 31, 13));
    expect(i).toBeGreaterThan(210);
    expect(strategyById('month_end_flow')!.signal(c, i)?.side).toBe(1); // long EUR/USD = selling dollars
    expect(strategyById('month_end_flow')!.signal(c, i - 24)).toBeNull();
  });

  it('weekend gap fill fades a gap that is still open after the first hour', () => {
    const times = tradingHours(300, Date.UTC(2024, 11, 30));
    const g = times.findIndex((t, i) => i > 215 && t - times[i - 1]! > 30 * H);
    const bars = times.map((t, i) => (i === g ? { t, o: 1.106, h: 1.1065, l: 1.1055, c: 1.106 } : flatBar(t, i > g ? 1.106 : 1.1)));
    const c = buildCtx(bars, 60, 'EURUSD');
    const sig = strategyById('weekend_gap')!.signal(c, g);
    expect(sig?.side).toBe(-1);
    expect(sig?.target).toBeCloseTo(1.1, 6);
  });

  it('NR7 breakout: yesterday the narrowest of 7 days, today breaks its high', () => {
    const t0 = Date.UTC(2025, 0, 6);
    const bars: Bar[] = [];
    for (let i = 0; i < 24 * 12; i++) {
      const t = t0 + i * H;
      const day = Math.floor(i / 24);
      const w = day === 10 ? 0.0004 : 0.003; // day 10 is narrow
      const mid = 1.1;
      const phase = (i % 24) / 23;
      const c = mid - w / 2 + w * phase;
      bars.push({ t, o: c, h: c + 0.00005, l: c - 0.00005, c });
    }
    // day 11, 09:00: close above day 10's high
    const k = 11 * 24 + 9;
    bars[k] = { ...bars[k]!, o: 1.1001, h: 1.1006, l: 1.1, c: 1.1005 };
    bars[k - 1] = { ...bars[k - 1]!, o: 1.1, h: 1.1001, l: 1.0999, c: 1.1 };
    const c = buildCtx(bars, 60, 'EURUSD');
    expect(c.nr7[k]).toBe(true);
    expect(strategyById('nr7_break')!.signal(c, k)?.side).toBe(1);
  });

  it('no peeking: cross-market strategies at bar i ignore readings after i', () => {
    const mk = (later: number) =>
      withExt(400, 'USDJPY', (e) => {
        for (let i = 0; i < 400; i++) {
          const v = Math.sin(i / 7) * 2;
          e.zOil[i] = e.zYield[i] = e.zStocks[i] = e.zDollar[i] = i > 330 ? v + later : v;
          e.rankBase[i] = i % 8;
          e.rankQuote[i] = 7 - (i % 8);
          e.spxMtd[i] = i > 330 ? 5 + later : 2.5;
        }
      }, 150);
    const a = mk(0);
    const b = mk(9);
    for (const s of STRATEGIES) for (let i = 220; i <= 330; i++) expect(JSON.stringify(s.signal(a, i))).toBe(JSON.stringify(s.signal(b, i)));
  });
});

describe('signal judge + rolling test + market links', () => {
  it('auc', () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5], [0, 1])).toBe(0.5);
    expect(auc([0.5, 0.5], [1, 1])).toBeNull();
  });

  function rows(n: number, informative: boolean): JudgeRow[] {
    let s = 17;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: n }, (_, k) => {
      const x = new Float64Array(JUDGE_FEATURES.length).map(() => rnd() * 2 - 1);
      // v17: chart and market type are real categories (the presence mask groups by them)
      x[JUDGE_FEATURES.indexOf('tf')] = k % 3 ? 1 : 4;
      x[JUDGE_FEATURES.indexOf('metal')] = k % 7 ? 0 : 1;
      const good = informative ? x[1]! > 0.2 : rnd() > 0.5;
      const r = good ? (rnd() < 0.7 ? 1.5 : -1) : rnd() < 0.3 ? 1.5 : -1;
      return { x, r, t: k };
    });
  }

  it('the judge switches on only when it beats taking every signal on the unseen part', async () => {
    const good = await trainJudge(rows(3000, true), 2100);
    expect(good.report.auc!).toBeGreaterThan(0.6);
    expect(good.report.keptR).toBeGreaterThan(good.report.allR);
    expect(good.report.active).toBe(true);
    expect(good.report.importance[0]!.feature).toBe('strength');
    const noise = await trainJudge(rows(3000, false), 2100);
    expect(noise.report.active).toBe(false);
    const tiny = await trainJudge(rows(200, true), 140);
    expect(tiny.model).toBeNull();
    expect(tiny.report.why).toMatch(/needs/);
  }, 30_000);

  it('rolling test re-picks each month from the months before only', () => {
    const t0 = Date.UTC(2025, 0, 1);
    const trades: WTrade[] = [];
    for (let d = 0; d < 360; d += 2) {
      const t = t0 + d * 86_400_000;
      // A wins all year; B wins in the first 6 months then loses
      trades.push({ pair: 'EURUSD', side: 1, entryT: t, exitT: t + 6 * H, r: 1, stopPct: 0.3, strategy: 'A', tf: '1h', sizeF: 1, key: 'A:1h', vf: 1 });
      trades.push({ pair: 'USDJPY', side: 1, entryT: t + H, exitT: t + 7 * H, r: d < 180 ? 1 : -1, stopPct: 0.3, strategy: 'B', tf: '1h', sizeF: 1, key: 'B:1h', vf: 1 });
    }
    const wf = walkForward(trades, { lookbackMonths: 3, minN: 10, minAvgR: 0.05, minPf: 1.15, always: () => false, sim: { maxOpen: 8, maxPerStrategy: 3, prioritise: true, ccyCapPct: 2.2, leverage: 30, marginShare: 0.25, ddSizing: true, flatSizing: false, baseRiskPct: 1 } })!;
    expect(wf.months[0]!.month).toBe('2025-04');
    // B is still picked while its last 3 months were good, then dropped once its losses fill the window
    const dec = wf.months.find((m) => m.month === '2025-12')!;
    expect(dec.picked).toBe(1);
    expect(wf.result.finalX).toBeGreaterThan(1);
  });

  it('market links: 24-hour z, month-to-date and strength ranks', () => {
    const t0 = Date.UTC(2025, 0, 1);
    const bars: Bar[] = [];
    let px = 70;
    for (let i = 0; i < 24 * 60; i++) {
      px *= 1 + Math.sin(i / 5) * 0.001;
      if (i === 24 * 50) px *= 1.05; // oil jumps 5%
      bars.push({ t: t0 + i * H, o: px, h: px, l: px, c: px });
    }
    const z = z24Series(bars);
    expect(z.v[24 * 50]!).toBeGreaterThan(3);
    // causal: changing the future leaves the past alone
    const later = bars.map((b, i) => (i > 24 * 50 ? { ...b, c: b.c * 2 } : b));
    const z2 = z24Series(later);
    for (let i = 0; i <= 24 * 50; i++) expect(Object.is(z.v[i], z2.v[i]) || z.v[i] === z2.v[i]).toBe(true);
    const m = mtdSeries(bars);
    expect(Number.isNaN(m.v[10]!)).toBe(true); // first month: no reference yet
    const feb = bars.findIndex((b) => b.t >= Date.UTC(2025, 1, 1));
    expect(m.v[feb]!).toBeCloseTo((bars[feb]!.c / bars[feb - 1]!.c - 1) * 100, 6);
    const trend = (n: number, start: number, d: number) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * H, o: start * Math.exp(d * i), h: start * Math.exp(d * i) * 1.0003, l: start * Math.exp(d * i) * 0.9997, c: start * Math.exp(d * i) }));
    const book = buildStrength({ EURUSD: trend(400, 1.1, 0.0004), EURJPY: trend(400, 160, 0.0004), EURGBP: trend(400, 0.85, 0.0004), GBPUSD: trend(400, 1.25, 0), USDJPY: trend(400, 150, 0), AUDUSD: trend(400, 0.65, -0.0004), USDCAD: trend(400, 1.35, 0), USDCHF: trend(400, 0.9, 0), NZDUSD: trend(400, 0.6, 0) });
    const ranks = strengthRanks(book);
    const g = book.times.length - 1;
    expect(ranks.EUR![g]).toBe(0);
    expect(ranks.AUD![g]).toBe(7);
  });
});

describe('bot account rules (v14)', () => {
  it('takes half off at +1R and moves the stop to break-even', () => {
    const T = Date.UTC(2026, 9, 20, 10);
    const a = newAccount(1000);
    a.open.push({ id: 'a', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 110, leverage: 100, stop: 1.095, target: 1.12, openedAt: T, checkedT: T, scaleAt: 1.105, scaleFrac: 0.5, scaled: false });
    const q = (bars: Array<[number, number, number, number]>, mid: number): Quote => ({ id: 'EURUSD', mid, bid: mid - 0.00004, ask: mid + 0.00004, t: 0, bars, dayChangePct: null, source: 'yahoo' });
    const ev = tick(a, { EURUSD: q([[T + 60_000, 1.1052, 1.1, 1.105]], 1.105) }, T + 70_000);
    expect(ev.join(' ')).toMatch(/50% off/);
    expect(a.open[0]!.units).toBeCloseTo(5_000);
    expect(a.open[0]!.stop).toBe(1.1);
    expect(a.closed[0]!.reason).toBe('partial');
    expect(a.balanceUsd).toBeCloseTo(1025, 0);
    // back to entry: the rest closes at break-even
    tick(a, { EURUSD: q([[T + 120_000, 1.104, 1.0995, 1.0998]], 1.0998) }, T + 130_000);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.reason).toBe('stop');
    expect(a.balanceUsd).toBeCloseTo(1025, 0);
  });
  it('market clock knows the rollover and the time since the weekly open', () => {
    expect(marketClock(Date.UTC(2026, 9, 20, 21, 30)).rollover).toBe(true);
    expect(marketClock(Date.UTC(2026, 9, 20, 12)).rollover).toBe(false);
    const sun = marketClock(Date.UTC(2026, 9, 18, 22, 0)); // Sun 18:00 New York (EDT)
    expect(sun.open).toBe(true);
    expect(sun.sinceOpenMin).toBe(60);
    expect(marketClock(Date.UTC(2026, 9, 17, 12)).sinceOpenMin).toBe(-1); // Saturday
  });
  it('simulate with precomputed signals still matches runSeries for the new strategies', () => {
    const t0 = Date.UTC(2025, 0, 6);
    let s = 3;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const bars: Bar[] = [];
    let px = 1.1;
    for (let i = 0; i < 2000; i++) {
      const o = px;
      const c = o + (rnd() - 0.5) * 0.003;
      bars.push({ t: t0 + i * H, o, h: Math.max(o, c) + rnd() * 0.001, l: Math.min(o, c) - rnd() * 0.001, c });
      px = c;
    }
    const c = buildCtx(bars, 60, 'EURUSD');
    for (const id of ['nr7_break', 'news_drift', 'weekend_gap']) {
      const st = strategyById(id)!;
      expect(simulate(EUR, '1h', c, id, signalsFor(c, st))).toEqual(runSeries(EUR, '1h', c, st));
    }
  });
});
