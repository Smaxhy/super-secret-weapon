import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { clearSpreadProfiles, profileFrom, setSpreadProfile, spreadMultAt } from '../src/forex/spreads';
import { DK, dkKey, loadDk, midBars, refreshDukascopy, stitchHistory } from '../src/forex/dukascopy';
import { carrySeries, cotPublicAt, cotScoreAt, cotSeries, FX_MACRO, parseBisCsv, parseCotRows, parseCotText, refreshMacro, valueAt, type MacroData } from '../src/forex/macro';
import { currentExpiries, nyCutOn, parseExpiries, parseRss } from '../src/forex/headlines';
import { harVolRatio, hurstVR, ouStats } from '../src/forex/quant';
import { blockReason, type FilterEnv } from '../src/forex/filters';
import { STAT_ARB_PAIRS, roundStep, strategyById } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import { extraVotes, gradeSniper, SNIPER, type SniperRow } from '../src/forex/sniper';
import { heatmapFor } from '../src/forex/heatmap';
import { simulatePortfolio, type PTrade } from '../src/forex/portfolio';
import { newAccount, Practice, type PracticeAccount, type Quote } from '../src/forex/practice';
import { MIGRATIONS } from '../src/config/migrations';
import { INSTRUMENTS, STRENGTH_PAIRS, type Bar } from '../src/forex/types';

const H = 3_600_000;
const DAY = 86_400_000;
const M = 60_000;
class MiniRedis {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) {
    return ks.map((k) => this.m.get(k) ?? null);
  }
}
const asRedis = (r: MiniRedis) => r as unknown as Redis;
const flat = (t: number, px: number): Bar => ({ t, o: px, h: px + 0.0001, l: px - 0.0001, c: px });

afterEach(() => {
  vi.useRealTimers();
  clearSpreadProfiles();
});

describe('v16 real spreads by hour', () => {
  it('rollover rule without a profile; measured shape with one, never cheaper than retail; weekend open ×4', () => {
    const t = (h: number) => Date.UTC(2026, 9, 14, h);
    expect(spreadMultAt('EURUSD', t(10), t(9))).toBe(1);
    expect(spreadMultAt('EURUSD', t(21), t(20))).toBe(3);
    expect(spreadMultAt('EURUSD', t(1), t(1) - 50 * H)).toBe(4);
    const samples: Array<[number, number]> = [];
    for (let d = 0; d < 30; d++) for (let h = 0; h < 24; h++) samples.push([Date.UTC(2026, 8, 1 + d, h), h === 22 ? 2.0 : h < 6 ? 0.4 : 0.2]);
    const p = profileFrom(samples)!;
    expect(p[22]).toBe(2);
    setSpreadProfile('EURUSD', p);
    expect(spreadMultAt('EURUSD', t(22), t(21))).toBe(6); // 2.0 ÷ median 0.2 = 10 → capped at 6
    expect(spreadMultAt('EURUSD', t(3), t(2))).toBe(2);
    expect(spreadMultAt('EURUSD', t(12), t(11))).toBe(1);
    expect(profileFrom(samples.slice(0, 50))).toBeNull();
  });
});

describe('v16 Dukascopy history', () => {
  it('mid bars from bid + ask with the close spread in pips', () => {
    const t = Date.UTC(2026, 0, 5, 10);
    const bars = midBars('EURUSD', [[t, 1.1, 1.101, 1.099, 1.1005]], [[t, 1.1001, 1.1011, 1.0991, 1.1007], [t + H, 1, 1, 1, 1]]);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.c).toBeCloseTo(1.1006, 6);
    expect(bars[0]!.s).toBeCloseTo(2, 6);
  });

  it('stitches older history only for FX and only when the seam lines up', () => {
    const now = Date.UTC(2026, 9, 1);
    const yahoo = Array.from({ length: 10 }, (_, i) => flat(now - 100 * DAY + i * H, 1.1));
    const dk = Array.from({ length: 20 }, (_, i) => ({ ...flat(now - 101 * DAY + i * H, 1.1), s: 0.2 }));
    expect(stitchHistory('EURUSD', yahoo, dk, now).length).toBe(10 + dk.filter((b) => b.t < yahoo[0]!.t).length);
    expect(stitchHistory('XAUUSD', yahoo, dk, now)).toHaveLength(10);
    const off = dk.map((b) => ({ ...b, c: 1.2 }));
    expect(stitchHistory('EURUSD', yahoo, off, now)).toHaveLength(10);
  });

  it('refresh pulls every market in pieces, stores mid bars and installs the spread profiles', async () => {
    const now = Date.UTC(2026, 9, 1);
    const redis = new MiniRedis();
    const calls: string[] = [];
    const fetcher = async (id: string, side: 'bid' | 'ask', from: Date, to: Date) => {
      calls.push(`${id}:${side}`);
      const rows: number[][] = [];
      for (let t = Math.ceil(from.getTime() / H) * H; t < to.getTime(); t += H) {
        const px = id.includes('JPY') ? 150 : 1.1;
        const pip = id.includes('JPY') ? 0.01 : 0.0001;
        const half = (new Date(t).getUTCHours() === 22 ? 3 : 0.5) * pip;
        const p = side === 'bid' ? px - half : px + half;
        rows.push([t, p, p, p, p]);
      }
      return rows;
    };
    const pause = DK.pauseMs;
    DK.pauseMs = 0;
    const meta = await refreshDukascopy(asRedis(redis), now, fetcher).finally(() => {
      DK.pauseMs = pause;
    });
    const ids = [...INSTRUMENTS.map((i) => i.id), ...STRENGTH_PAIRS.map((p) => p.id)];
    expect(Object.keys(meta.ids).sort()).toEqual(ids.sort());
    expect(calls.length).toBe(ids.length * 2 * Math.ceil(DK.historyDays / DK.chunkDays));
    const eur = await loadDk(asRedis(redis), 'EURUSD');
    expect(eur.length).toBeGreaterThan(20_000);
    expect(spreadMultAt('EURUSD', Date.UTC(2026, 9, 1, 22), Date.UTC(2026, 9, 1, 21))).toBe(6);
    // within the refresh window: no new download
    calls.length = 0;
    await refreshDukascopy(asRedis(redis), now + H, fetcher);
    expect(calls).toHaveLength(0);
    expect(redis.m.has(dkKey('AUDNZD'))).toBe(true);
  }, 60_000);
});

describe('v16 macro: CFTC positioning + policy rates', () => {
  it('parses CFTC rows (loose field names) and the weekly text file; public only from the Friday after', () => {
    const rows = [
      { market_and_exchange_names: 'EURO FX - CHICAGO MERCANTILE EXCHANGE', report_date_as_yyyy_mm_dd: '2026-10-13T00:00:00.000', open_interest_all: '700000', lev_money_positions_long: '200000', lev_money_positions_short: '60000' },
      { market_and_exchange_names: 'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE', report_date_as_yyyy_mm_dd: '2026-10-13T00:00:00.000', open_interest_all: '300000', lev_money_positions_long_all: '30000', lev_money_positions_short_all: '90000' },
      { market_and_exchange_names: 'GOLD - COMMODITY EXCHANGE', report_date_as_yyyy_mm_dd: '2026-10-13', open_interest_all: '1', lev_money_positions_long: '1', lev_money_positions_short: '0' },
    ];
    const c = parseCotRows(rows);
    expect(Object.keys(c).sort()).toEqual(['EUR', 'JPY']);
    expect(c.EUR![0]![1]).toBeCloseTo(0.2, 6);
    expect(c.JPY![0]![1]).toBeCloseTo(-0.2, 6);
    expect(c.EUR![0]![0]).toBe(cotPublicAt(Date.UTC(2026, 9, 13)));
    expect(new Date(c.EUR![0]![0]).getUTCDay()).toBe(5);
    const txt = '"EURO FX - CHICAGO MERCANTILE EXCHANGE",261013,2026-10-13,099741,CME,00,099,700000,1,1,1,1,1,1,200000,60000,0';
    expect(parseCotText(txt).EUR![0]![1]).toBeCloseTo(0.2, 6);
  });

  it('BIS monthly rates count from the next month; carry = base − quote, metals pay nothing', () => {
    const csv = 'FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nM,US,2026-08,4.25\nM,US,2026-09,4.0\nM,XM,2026-09,2.0\nM,JP,2026-09,0.75\nM,GB,2026-09,3.75';
    const r = parseBisCsv(csv);
    expect(valueAt(r.USD, Date.UTC(2026, 8, 15))).toBe(4.25); // September uses August's rate
    expect(valueAt(r.USD, Date.UTC(2026, 9, 2))).toBe(4.0);
    expect(valueAt(r.EUR, Date.UTC(2026, 8, 15))).toBeNaN();
    const m: MacroData = { at: 0, cot: {}, rates: r, errors: [] };
    const bars = [flat(Date.UTC(2026, 9, 5), 1.1)];
    expect(carrySeries(m, 'EURUSD', bars, 60)[0]).toBeCloseTo(-2, 6);
    expect(carrySeries(m, 'USDJPY', bars, 60)[0]).toBeCloseTo(3.25, 6);
    expect(carrySeries(m, 'XAUUSD', bars, 60)[0]).toBeCloseTo(-4, 6);
    expect(carrySeries(null, 'EURUSD', bars, 60)[0]).toBeNaN();
  });

  it('positioning score is causal: ranks the latest public week within its own history; USD counts as 0', () => {
    const xs: Array<[number, number]> = Array.from({ length: 60 }, (_, w) => [w * 7 * DAY, w / 100]);
    expect(cotScoreAt(xs, 59 * 7 * DAY)).toBe(1);
    expect(cotScoreAt(xs, 10 * 7 * DAY)).toBeNaN(); // under 26 weeks of history
    expect(cotScoreAt(xs, 40 * 7 * DAY + DAY)).toBe(1);
    const m: MacroData = { at: 0, cot: { EUR: xs }, rates: {}, errors: [] };
    const bars = [flat(30 * 7 * DAY, 1.1), flat(59 * 7 * DAY, 1.1)];
    const s = cotSeries(m, 'EURUSD', bars, 60);
    expect(s[1]).toBe(1);
    expect(cotSeries(m, 'USDJPY', bars, 60)[1]).toBeNaN(); // no JPY data
    expect(cotSeries(m, 'XAUUSD', bars, 60)[1]).toBeNaN();
  });

  it('refresh uses the history API, falls back to the weekly file, keeps old data on failure', async () => {
    const redis = new MiniRedis();
    const now = Date.UTC(2026, 9, 17);
    const fetchers = {
      json: async () => {
        throw new Error('HTTP 503');
      },
      text: async (u: string) => (u.includes('cftc') ? '"EURO FX - CHICAGO MERCANTILE EXCHANGE",261013,2026-10-13,099741,CME,00,099,700000,1,1,1,1,1,1,200000,60000,0' : 'REF_AREA,TIME_PERIOD,OBS_VALUE\nUS,2026-09,4\nXM,2026-09,2\nJP,2026-09,0.75\nGB,2026-09,3.75\nCH,2026-09,0'),
    };
    const m = await refreshMacro(asRedis(redis), now, fetchers);
    expect(m.cot.EUR).toHaveLength(1);
    expect(Object.keys(m.rates)).toHaveLength(5);
    expect(m.errors.some((e) => e.includes('CFTC history'))).toBe(true);
    expect(JSON.parse(redis.m.get(FX_MACRO)!).cot.EUR).toHaveLength(1);
  });
});

describe('v16 option expiries (ForexLive)', () => {
  it('10:00 New York cut in summer and winter; levels and sizes from the post body', () => {
    expect(new Date(nyCutOn(Date.UTC(2026, 6, 1, 8))).toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(new Date(nyCutOn(Date.UTC(2026, 11, 1, 8))).toISOString()).toBe('2026-12-01T15:00:00.000Z');
    const t = Date.UTC(2026, 9, 19, 8, 30);
    const e = parseExpiries('EUR/USD: 1.1650 (€1.2bn), 1.1700 (€820m). USD/JPY: 150.50 ($1.1bn). AUD/USD 0.6550 (A$600m)', t);
    expect(e.map((x) => `${x.pair}@${x.level}:${x.sizeBn}`)).toEqual(['EURUSD@1.165:1.2', 'EURUSD@1.17:0.82', 'USDJPY@150.5:1.1', 'AUDUSD@0.655:0.6']);
    const xml = `<rss><item><title>FX option expiries for 19 October 10am New York cut</title><link>x</link><pubDate>${new Date(t).toUTCString()}</pubDate><description><![CDATA[<p>EUR/USD: 1.1650 (€1.2bn)</p>]]></description></item></rss>`;
    const items = parseRss(xml, 'forexlive.com');
    expect(items[0]!.expiries).toHaveLength(1);
    expect(currentExpiries(items, t)).toHaveLength(1);
    expect(currentExpiries(items, t + 10 * H)).toHaveLength(0); // the cut passed hours ago
  });
});

describe('v16 quant readings', () => {
  const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  it('volatility forecast > 1 after a quiet day in a wild month; Hurst separates trends from snap-backs; OU z and half-life', () => {
    const close = [1];
    for (let i = 1; i < 1000; i++) close.push(close[i - 1]! * (1 + (i > 976 ? 0.00005 : 0.003) * (i % 2 ? 1 : -1)));
    const v = harVolRatio(close, 60);
    expect(v[999]).toBeGreaterThan(2);
    expect(v[700]).toBeLessThan(1.2);
    expect(v[400]).toBeNaN(); // under a month of bars
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
    const trend = [1];
    let d = 0;
    for (let i = 1; i < 600; i++) {
      d = 0.9 * d + 0.1 * rnd() * 0.002;
      trend.push(trend[i - 1]! * (1 + d * 5 + rnd() * 0.0003));
    }
    const chop = series(600, (i) => 1 + (i % 2 ? 0.001 : -0.001) + rnd() * 0.0002);
    expect(hurstVR(trend)[599]).toBeGreaterThan(0.55);
    expect(hurstVR(chop)[599]).toBeLessThan(0.3);
    const ou = [Math.log(1)];
    for (let i = 1; i < 400; i++) ou.push(ou[i - 1]! * 0.9 + rnd() * 0.002);
    const st = ouStats(ou.map((x) => Math.exp(x)));
    expect(Number.isFinite(st.hl[399])).toBe(true);
    expect(st.hl[399]!).toBeLessThan(20);
    // causal: changing later bars never changes an earlier reading
    const later = [...close.slice(0, 990), ...close.slice(990).map((x) => x * 1.1)];
    expect(harVolRatio(later, 60)[980]).toBe(v[980]);
  });
});

describe('v16 filters', () => {
  const env = (o: Partial<FilterEnv>): FilterEnv => ({ tf: '1h', gap: Float64Array.of(NaN), h4: Int8Array.of(0), d1: Int8Array.of(0), mood: Float64Array.of(NaN), riskLong: 0, ...o });
  it('volatility forecast, trend / chop and crowded positioning veto only the wrong entries; no data never blocks', () => {
    expect(blockReason('volf', env({ volF: Float64Array.of(0.8) }), 0, 1, 'trend')).toMatch(/calm/);
    expect(blockReason('volf', env({ volF: Float64Array.of(1.3) }), 0, 1, 'trend')).toBeNull();
    expect(blockReason('volf', env({ volF: Float64Array.of(1.3) }), 0, 1, 'revert')).toMatch(/bigger/);
    expect(blockReason('hurst', env({ hurst: Float64Array.of(0.4) }), 0, 1, 'trend')).toMatch(/snapping/);
    expect(blockReason('hurst', env({ hurst: Float64Array.of(0.4) }), 0, 1, 'revert')).toBeNull();
    expect(blockReason('crowd', env({ cot: Float64Array.of(1.5) }), 0, 1)).toMatch(/crowded long/);
    expect(blockReason('crowd', env({ cot: Float64Array.of(1.5) }), 0, -1)).toBeNull();
    expect(blockReason('crowd', env({}), 0, 1)).toBeNull();
  });
});

describe('v16 strategies', () => {
  const T0 = Date.UTC(2025, 0, 6);
  it('round-number break fires on a close through a big figure; the step per market', () => {
    expect(roundStep('EURUSD')).toBe(0.01);
    expect(roundStep('USDJPY')).toBe(1);
    expect(roundStep('XAUUSD')).toBe(10);
    const bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * H, o: 1.0995, h: 1.0998, l: 1.0992, c: 1.0995 }));
    bars.push({ t: T0 + 60 * H, o: 1.0995, h: 1.1004, l: 1.0994, c: 1.1003 });
    const c = buildCtx(bars, 60, 'EURUSD');
    const sig = strategyById('round_break')!.signal(c, 60);
    expect(sig?.side).toBe(1);
    expect(sig!.stop).toBeLessThan(1.1);
  });

  it('stat-arb only on the linked crosses, against a stretched price, target = the average', () => {
    expect(STAT_ARB_PAIRS).toContain('AUDNZD');
    let s = 3;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
    const bars: Bar[] = [];
    let x = 0;
    for (let i = 0; i < 400; i++) {
      x = 0.8 * x + rnd() * 0.002;
      const px = 1.08 * Math.exp(i === 399 ? 0.012 : x);
      bars.push({ t: T0 + i * H, o: px, h: px * 1.0002, l: px * 0.9998, c: px });
    }
    const st = strategyById('stat_arb')!;
    const sig = st.signal(buildCtx(bars, 60, 'AUDNZD'), 399);
    expect(sig?.side).toBe(-1);
    expect(sig!.target!).toBeLessThan(bars[399]!.c);
    expect(st.signal(buildCtx(bars, 60, 'EURUSD'), 399)).toBeNull();
  });

  it('carry + trend needs the rates feed; momentum blend fires when all three horizons agree', () => {
    const up = Array.from({ length: 600 }, (_, i) => flat(T0 + i * H, 1 + (i < 590 ? -i * 0.00001 : (i - 600) * -0.0005)));
    const c = buildCtx(up, 60, 'AUDJPY');
    expect(strategyById('carry_trend')!.signal(c, 599)).toBeNull();
    // falls for 500 bars, then rises: the 1-day, 5-day and finally the 20-day return turn up → one long, once
    const vee = Array.from({ length: 1300 }, (_, i) => flat(T0 + i * H, 1.2 + (i < 500 ? -i : -1000 + i) * 0.0002));
    const cr = buildCtx(vee, 60, 'EURUSD');
    const fires = Array.from({ length: 1300 }, (_, i) => strategyById('mom_blend')!.signal(cr, i)).filter(Boolean);
    expect(fires.length).toBe(1);
    expect(fires[0]!.side).toBe(1);
  });
});

describe('v16 sniper', () => {
  it('picks the vote level on the first 70% and turns on only when the unseen part confirms', () => {
    const mk = (n: number, t0: number, votes: number, r: (k: number) => number): SniperRow[] => Array.from({ length: n }, (_, k) => ({ t: t0 + k, r: r(k), votes }));
    const good = [...mk(200, 0, 4, (k) => (k % 2 ? 0.4 : -0.5)), ...mk(40, 300, 9, (k) => (k % 3 ? 1.2 : -1)), ...mk(80, 1000, 4, (k) => (k % 2 ? 0.4 : -0.5)), ...mk(20, 1200, 9, (k) => (k % 3 ? 1.2 : -1))];
    const on = gradeSniper(good, 1000);
    expect(on.active).toBe(true);
    expect(on.k).toBeLessThanOrEqual(9);
    expect(on.why).toMatch(/risk 8%/);
    const fails = [...good.filter((x) => x.t < 1000), ...mk(20, 1200, 9, (k) => (k % 2 ? 0.3 : -1))];
    expect(gradeSniper(fails, 1000).active).toBe(false);
    expect(gradeSniper(good.filter((x) => x.votes < 9), 1000).k).toBeNull();
    expect(gradeSniper([], 1000).why).toMatch(/no trades/);
  });

  it('extra votes read momentum, carry, volatility, Hurst, positioning and room', () => {
    const bars = Array.from({ length: 600 }, (_, i) => ({ t: Date.UTC(2025, 0, 6) + i * H, o: 1 + i * 0.0001, h: 1 + i * 0.0001 + 0.0003, l: 1 + i * 0.0001 - 0.0003, c: 1.00005 + i * 0.0001 }));
    const c = buildCtx(bars, 60, 'EURUSD');
    const n = bars.length;
    const e: FilterEnv = { tf: '1h', gap: new Float64Array(n).fill(NaN), h4: new Int8Array(n), d1: new Int8Array(n), mood: new Float64Array(n).fill(NaN), riskLong: 0, carry: new Float64Array(n).fill(1), cot: new Float64Array(n).fill(-1.2), volF: new Float64Array(n).fill(1.1), hurst: new Float64Array(n).fill(0.6) };
    const v = extraVotes(c, e, n - 1, 1, 'trend');
    expect(v.yes.join(' ')).toMatch(/momentum.*carry.*rise.*continuing.*squeeze/);
    expect(v.of).toBe(6);
    expect(extraVotes(c, e, n - 1, -1, 'trend').total).toBeLessThan(v.total);
  });

  it('the honest test lets a sniper trade past the currency cap, one at a time', () => {
    const base = { maxOpen: 8, leverage: 30, marginShare: 0.25, maxPerStrategy: 3, prioritise: true, ccyCapPct: 2.2, ddSizing: false, flatSizing: false, baseRiskPct: 1, label: 'x' };
    const t = (k: number, pair: string, sn: boolean): PTrade => ({ pair, side: 1, entryT: k * H, exitT: k * H + 10 * H, r: 1, stopPct: 0.2, strategy: `s${k}`, tf: '1h', sizeF: sn ? SNIPER.riskPct : 1, ...(sn ? { maxMult: SNIPER.riskPct, lev: SNIPER.leverage, sniper: true } : {}) });
    // the 2nd sniper waits (one at a time); a normal USD/JPY long lowers the dollar exposure, so the cap lets it in
    const r = simulatePortfolio([t(0, 'EURUSD', true), t(1, 'GBPUSD', true), t(2, 'USDJPY', false)], base);
    expect(r.trades).toBe(2);
    expect(r.finalX).toBeCloseTo(1 + 0.08 + 0.01, 2);
  });

  it('the bot account opens a proven sniper trade at the sniper size, past the currency cap, one at a time', async () => {
    const WED = Date.UTC(2026, 9, 14, 12);
    vi.useFakeTimers({ now: WED });
    const redis = new MiniRedis();
    redis.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const practice = new Practice(asRedis(redis));
    const q = (id: string, mid: number): Quote => ({ id, mid, bid: mid - 0.00004, ask: mid + 0.00004, t: WED, bars: [[WED - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: WED });
    (practice as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: q('EURUSD', 1.1), GBPUSD: q('GBPUSD', 1.27) });
    const base = { tf: '1h', side: 1 as const, entryT: WED - 60_000, chosen: true, sizeF: 1, prio: 0.2, judge: null, conviction: null };
    const sniper = { votes: 9, of: 12, k: 8, on: true, yes: ['momentum on 1, 5 and 20 days'] };
    await practice.syncBot(
      [
        { ...base, ref: `a:1h:EURUSD:${WED}`, strategy: 'a', pair: 'EURUSD', stop: 1.098, target: 1.106, sniper },
        { ...base, ref: `b:1h:GBPUSD:${WED}`, strategy: 'b', pair: 'GBPUSD', stop: 1.268, target: 1.276, sniper },
      ],
      () => null,
      {},
      { scope: ['1h', '4h'] },
    );
    const a = JSON.parse(redis.m.get('fx:practice:bot')!) as PracticeAccount;
    const eur = a.open.find((p) => p.pair === 'EURUSD')!;
    expect(eur.sniper?.votes).toBe(9);
    expect(eur.riskPct).toBeCloseTo(SNIPER.riskPct, 0);
    expect(eur.leverage).toBe(SNIPER.leverage);
    // the second sniper setup is a normal trade (one sniper at a time) and the currency cap stops it piling on USD
    expect(a.open.find((p) => p.pair === 'GBPUSD')?.sniper).toBeUndefined();
  });
});

describe('v16 heatmap', () => {
  it('lists round numbers, swing levels, yesterday and option expiries near the price, with the engines read', () => {
    const T0 = Date.UTC(2025, 0, 6);
    const bars = Array.from({ length: 300 }, (_, i) => ({ t: T0 + i * H, o: 1.1003, h: 1.1012, l: 1.0994, c: 1.1003 }));
    const c = buildCtx(bars, 60, 'EURUSD');
    const n = bars.length;
    const e: FilterEnv = { tf: '1h', gap: new Float64Array(n).fill(NaN), h4: new Int8Array(n), d1: new Int8Array(n), mood: new Float64Array(n).fill(NaN), riskLong: 0, carry: new Float64Array(n).fill(-2) };
    const h = heatmapFor(c, e, { lines: [], levels: [{ kind: 'resistance', price: 1.1021, touches: 3 }], prevDay: { h: 1.1012, l: 1.0994 }, asia: null }, [{ pair: 'EURUSD', level: 1.1015, sizeBn: 2, cutT: 0 }, { pair: 'USDJPY', level: 150, sizeBn: 1, cutT: 0 }]);
    expect(h.levels.some((l) => l.kind === 'round' && Math.abs(l.price - 1.1) < 1e-9)).toBe(true);
    expect(h.levels.some((l) => l.kind === 'expiry')).toBe(true);
    expect(h.levels.every((l) => Math.abs(l.distAtr) <= 4)).toBe(true);
    expect(h.read.carry).toBe(-2);
    expect(h.read.positioning).toBeNull();
  });
});

describe('v16 crypto in the background', () => {
  it('migration v56 switches the heavy crypto research jobs off / down', () => {
    const m = MIGRATIONS.find((x) => x.version === 56)!;
    expect(m.create).toBe(true);
    const keys = m.set.map(([s, p]) => `${s}.${(p as string[]).join('.')}`);
    expect(keys).toEqual(expect.arrayContaining(['ta.labEnabled', 'tournament.enabled', 'outcomes.maxPerTick']));
  });
});
