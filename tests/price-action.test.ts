import { describe, expect, it } from 'vitest';
import { analyzePriceAction, buildCandles, logTrend, roundTripCostPct, swings } from '../src/evaluator/price-action';
import { makeTape, noisy, path, T0 } from './tape-helpers';

const at = (sec: number) => T0 + sec * 1000;

describe('candles & trend', () => {
  it('buckets trades into 15s candles with OHLC and flow', () => {
    const tape = makeTape({ price: path([[0, 1], [60, 2]]), durationSec: 60, tradeEverySec: 1 });
    const candles = buildCandles(tape);
    expect(candles.length).toBeGreaterThanOrEqual(4);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.trades).toBeGreaterThan(0);
    }
  });
  it('regression slope is positive on an uptrend and negative on a downtrend', () => {
    const up = logTrend([0, 1, 2, 3, 4].map((m) => ({ tMs: at(m * 60), price: 1 * 1.1 ** m })));
    const down = logTrend([0, 1, 2, 3, 4].map((m) => ({ tMs: at(m * 60), price: 1 * 0.9 ** m })));
    expect(up.slopePctPerMin).toBeCloseTo(10, 0);
    expect(up.r2).toBeCloseTo(1, 5);
    expect(down.slopePctPerMin).toBeCloseTo(-10, 0);
  });
  it('finds swing highs and lows', () => {
    const tape = makeTape({ price: path([[0, 1], [30, 2], [60, 1.2], [90, 2.5], [120, 1.5]]), durationSec: 120, tradeEverySec: 1, buyProbUp: 0.9, buyProbDown: 0.1 });
    const sw = swings(buildCandles(tape));
    expect(sw.highs.length).toBeGreaterThanOrEqual(1);
    expect(sw.lows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('setup classification', () => {
  it('a clean grind is GRIND or BREAKOUT with positive trend and good strength', () => {
    const tape = makeTape({ price: path([[0, 1], [300, 3]]), durationSec: 300, tradeEverySec: 1.5, wallets: 60 });
    const pa = analyzePriceAction(tape, 0, at(300));
    expect(pa.trendSlopePctPerMin).toBeGreaterThan(0.5);
    expect(['GRIND', 'BREAKOUT']).toContain(pa.setup);
    expect(pa.strength).toBeGreaterThan(0.5);
    expect(pa.manipulation).toBeLessThan(0.3);
    expect(pa.drawdownFromAthPct).toBeLessThan(5);
  });
  it('a vertical candle is EXTENDED', () => {
    // flat for 3 minutes, then +120% in the last 45 seconds
    const tape = makeTape({ price: path([[0, 1], [180, 1.05], [225, 2.3]]), durationSec: 225, tradeEverySec: 1, buyProbUp: 0.95 });
    const pa = analyzePriceAction(tape, 0, at(225));
    expect(pa.change60Pct).toBeGreaterThan(40);
    expect(pa.setup).toBe('EXTENDED');
  });
  it('a pullback in an uptrend is PULLBACK with support below and the ATH above', () => {
    const tape = makeTape({ price: path([[0, 1], [60, 1.6], [90, 1.3], [150, 2.4], [180, 2.0], [240, 3.2], [270, 2.6]]), durationSec: 270, tradeEverySec: 1, buyProbDown: 0.5 });
    const pa = analyzePriceAction(tape, 0, at(270));
    expect(pa.setup).toBe('PULLBACK');
    expect(pa.higherLows).toBeGreaterThanOrEqual(1);
    expect(pa.support).not.toBeNull();
    expect(pa.support!).toBeLessThan(pa.priceSol);
    expect(pa.resistance).toBeCloseTo(pa.athPriceSol, 12);
    expect(pa.drawdownFromAthPct).toBeGreaterThan(8);
  });
  it('a pump that is being sold off is BREAKDOWN or DISTRIBUTION', () => {
    const tape = makeTape({ price: path([[0, 1], [90, 3], [120, 2.2], [180, 1.4], [240, 1.0]]), durationSec: 240, tradeEverySec: 1, buyProbDown: 0.15 });
    const pa = analyzePriceAction(tape, 0, at(240));
    expect(['BREAKDOWN', 'DISTRIBUTION']).toContain(pa.setup);
    expect(pa.buyVolShare60).toBeLessThan(0.45);
    expect(pa.drawdownFromAthPct).toBeGreaterThan(50);
  });
  it('too few trades is THIN', () => {
    const tape = makeTape({ price: path([[0, 1], [60, 1.2]]), durationSec: 60, tradeEverySec: 15 });
    expect(analyzePriceAction(tape, 0, at(60)).setup).toBe('THIN');
  });
});

describe('manipulation detection', () => {
  it('one wallet buying everything scores high', () => {
    const tape = makeTape({ price: path([[0, 1], [120, 2]]), durationSec: 120, tradeEverySec: 1, wallet: (_t, _r, isBuy) => (isBuy ? 'WHALE' : undefined) });
    const pa = analyzePriceAction(tape, 0, at(120));
    expect(pa.topBuyerShare60).toBeGreaterThan(0.9);
    expect(pa.manipulation).toBeGreaterThan(0.6);
  });
  it('wash trading (same wallets flipping both ways, uniform sizes) scores high', () => {
    const bots = ['B1', 'B2', 'B3'];
    const tape = makeTape({
      price: path([[0, 1], [120, 1.8]]),
      durationSec: 120,
      tradeEverySec: 0.7,
      side: (t) => Math.round(t * 10) % 2 === 0,
      size: () => 0.25,
      wallet: (_t, r) => bots[Math.floor(r * bots.length)],
    });
    const pa = analyzePriceAction(tape, 0, at(120));
    expect(pa.churnRatio).toBeGreaterThan(0.6);
    expect(pa.buySizeCv).not.toBeNull();
    expect(pa.buySizeCv!).toBeLessThan(0.15);
    expect(pa.manipulation).toBeGreaterThanOrEqual(0.6);
  });
  it('a broad organic base scores low', () => {
    const tape = makeTape({ price: path([[0, 1], [120, 1.8]]), durationSec: 120, tradeEverySec: 1, wallets: 80 });
    expect(analyzePriceAction(tape, 0, at(120)).manipulation).toBeLessThan(0.3);
  });
});

describe('round-trip cost', () => {
  it('two curve fees + two slippages', () => expect(roundTripCostPct(125, 1.5)).toBeCloseTo(5.5));
});

describe('noise robustness', () => {
  it('a noisy grind is still read as an uptrend', () => {
    const tape = makeTape({ price: noisy(path([[0, 1], [300, 2.5]]), 4), durationSec: 300, tradeEverySec: 1.2, wallets: 60 });
    const pa = analyzePriceAction(tape, 0, at(300));
    expect(pa.trendSlopePctPerMin).toBeGreaterThan(0.3);
    expect(pa.trendR2).toBeGreaterThan(0.6);
  });
});
