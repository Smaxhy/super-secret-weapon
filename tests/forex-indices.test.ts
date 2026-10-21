/** v27 (owner: "trade Nasdaq too, Nasdaq 100 etc"): US stock indices as forex-lab markets. */
import { describe, expect, it } from 'vitest';
import { INSTRUMENTS, digitsOf, isFutures, isIndex, maxLeverageFor } from '../src/forex/types';
import { runsOn, roundStep, strategyById } from '../src/forex/strategies';
import { feePctPerSide } from '../src/forex/venue-fees';
import { newsBlock, parseCalendar } from '../src/forex/calendar';
import { classify, headlineBlock } from '../src/forex/headlines';
import { carrySeries, type MacroData } from '../src/forex/macro';
import { riskOfLong } from '../src/forex/mood';
import { pnlUsd, unitsFor } from '../src/forex/practice';
import { lagBars } from '../src/forex/freshness';

const NDX = INSTRUMENTS.find((i) => i.id === 'NDXUSD')!;
const H = 3_600_000;

describe('v27 stock indices', () => {
  it('four US indices on their CME futures, USD-priced, futures-like', () => {
    const ids = INSTRUMENTS.filter((i) => i.kind === 'index').map((i) => [i.id, i.yahoo]);
    expect(ids).toEqual([['NDXUSD', 'NQ=F'], ['SPXUSD', 'ES=F'], ['DJIUSD', 'YM=F'], ['RUTUSD', 'RTY=F']]);
    expect(isIndex('NDXUSD') && isFutures('NDXUSD') && isFutures('XAUUSD')).toBe(true);
    expect(isFutures('EURUSD') || isIndex('BTCUSD')).toBe(false);
    expect(digitsOf('NDXUSD')).toBe(2);
    expect(digitsOf('EURUSD')).toBe(5);
    expect(digitsOf('USDJPY')).toBe(3);
    expect(digitsOf('XAUUSD')).toBe(2);
    expect(maxLeverageFor('NDXUSD')).toBe(50);
    expect(maxLeverageFor('BTCUSD')).toBe(20);
    expect(maxLeverageFor('EURUSD')).toBe(Infinity);
    expect(roundStep('NDXUSD')).toBe(100);
  });

  it('currency-only rules never run on an index; chart and NY-open rules do', () => {
    for (const id of ['fix_flow', 'carry_trend', 'local_hours', 'month_end_flow', 'stat_arb']) expect(runsOn(strategyById(id)!, '1h', 'NDXUSD')).toBe(false);
    expect(runsOn(strategyById('ema_cross')!, '1h', 'NDXUSD')).toBe(true);
    expect(runsOn(strategyById('judas_swing')!, '1h', 'SPXUSD')).toBe(true);
    expect(runsOn(strategyById('fix_flow')!, '1h', 'EURUSD')).toBe(true);
  });

  it('pays the index venue fee and is a risk-on asset', () => {
    expect(feePctPerSide(NDX)).toBe(0.03);
    expect(riskOfLong('NDXUSD')).toBeGreaterThan(1);
  });

  it('US news and big US headlines pause an index', () => {
    const ev = parseCalendar([{ title: 'CPI m/m', country: 'USD', date: '2026-11-12T08:30:00-05:00', impact: 'High', forecast: '', previous: '' }]);
    const cpi = Date.parse('2026-11-12T13:30:00Z');
    expect(newsBlock('NDXUSD', cpi - 10 * 60_000, ev)).toMatch(/USD news/);
    const h = classify('Nasdaq plunges as Powell speech surprises markets');
    expect(h.ccys).toContain('NDX');
    expect(h.severity).toBe('high');
    expect(headlineBlock('NDXUSD', 1000, [{ t: 1000, title: 'x', link: '', source: 's', ...h }])).toMatch(/headline/);
  });

  it('financed at minus the dollar rate, like a CFD; no positioning', () => {
    const m: MacroData = { at: 0, cot: {}, rates: { USD: [[Date.UTC(2026, 8, 1), 4]] }, errors: [] };
    const bars = [{ t: Date.UTC(2026, 9, 5), o: 1, h: 1, l: 1, c: 1 }];
    expect(carrySeries(m, 'NDXUSD', bars, 60)[0]).toBeCloseTo(-4, 6);
  });

  it('one unit = $1 a point', () => {
    const units = unitsFor(NDX, 25_000, { NDXUSD: 25_000 })!;
    expect(units).toBeCloseTo(1, 9);
    expect(pnlUsd({ pair: 'NDXUSD', side: 1, units, entry: 25_000 }, 25_100, {})).toBeCloseTo(100, 6);
  });

  it('the CME daily halt hour is not counted as a missing candle', () => {
    const now = Date.UTC(2026, 9, 14, 23, 5); // Wed 19:05 New York; the 21:00 UTC (17:00 NY) bar never exists
    expect(lagBars('NDXUSD', Date.UTC(2026, 9, 14, 22), now, H)).toBe(0);
    expect(lagBars('NDXUSD', Date.UTC(2026, 9, 14, 20), now, H)).toBe(1);
  });
});
