/** Forex lab (v12): shared types + the instrument list. Prices are plain quotes (EUR/USD 1.0842, gold 2,650.4). */

export interface Bar {
  /** bar open time, ms UTC */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** v27.35: traded volume of the candle (coins, stock indices, metals); absent where the feed has none (spot FX) */
  v?: number;
}

export interface Instrument {
  id: string;
  label: string;
  /** Yahoo Finance symbol (free chart API, no key) */
  yahoo: string;
  /** size of one pip in price */
  pip: number;
  /** typical retail spread in pips (round trip cost = 1 spread) */
  spreadPips: number;
  /** v22: 'crypto' = a coin against USD (24/7, no central bank, no weekend, no rollover).
   * v27: 'index' = a US stock index, tested on its CME future (Yahoo NQ=F etc.): USD-priced like a metal, same
   * Sunday-to-Friday hours with the daily 17:00–18:00 New York halt; 1 unit = $1 a point. */
  kind: 'fx' | 'metal' | 'crypto' | 'index';
}

export const INSTRUMENTS: Instrument[] = [
  { id: 'EURUSD', label: 'EUR/USD', yahoo: 'EURUSD=X', pip: 0.0001, spreadPips: 0.8, kind: 'fx' },
  { id: 'GBPUSD', label: 'GBP/USD', yahoo: 'GBPUSD=X', pip: 0.0001, spreadPips: 1.2, kind: 'fx' },
  { id: 'USDJPY', label: 'USD/JPY', yahoo: 'JPY=X', pip: 0.01, spreadPips: 1.0, kind: 'fx' },
  { id: 'AUDUSD', label: 'AUD/USD', yahoo: 'AUDUSD=X', pip: 0.0001, spreadPips: 1.0, kind: 'fx' },
  { id: 'USDCAD', label: 'USD/CAD', yahoo: 'CAD=X', pip: 0.0001, spreadPips: 1.5, kind: 'fx' },
  { id: 'USDCHF', label: 'USD/CHF', yahoo: 'CHF=X', pip: 0.0001, spreadPips: 1.5, kind: 'fx' },
  { id: 'NZDUSD', label: 'NZD/USD', yahoo: 'NZDUSD=X', pip: 0.0001, spreadPips: 1.5, kind: 'fx' },
  { id: 'EURJPY', label: 'EUR/JPY', yahoo: 'EURJPY=X', pip: 0.01, spreadPips: 1.5, kind: 'fx' },
  { id: 'GBPJPY', label: 'GBP/JPY', yahoo: 'GBPJPY=X', pip: 0.01, spreadPips: 2.5, kind: 'fx' },
  { id: 'EURGBP', label: 'EUR/GBP', yahoo: 'EURGBP=X', pip: 0.0001, spreadPips: 1.2, kind: 'fx' },
  // v16: two crosses of closely linked currencies (the stat-arb candidates)
  { id: 'AUDNZD', label: 'AUD/NZD', yahoo: 'AUDNZD=X', pip: 0.0001, spreadPips: 2.5, kind: 'fx' },
  { id: 'EURCHF', label: 'EUR/CHF', yahoo: 'EURCHF=X', pip: 0.0001, spreadPips: 1.8, kind: 'fx' },
  { id: 'XAUUSD', label: 'Gold', yahoo: 'GC=F', pip: 0.01, spreadPips: 30, kind: 'metal' },
  { id: 'XAGUSD', label: 'Silver', yahoo: 'SI=F', pip: 0.001, spreadPips: 30, kind: 'metal' },
  // v27 (owner: "trade Nasdaq too, Nasdaq 100 etc"): US stock indices on their CME futures. Ids end in USD (like the
  // metals and coins) so every "base / quote" reading sees an asset priced in dollars. pip = 1 point (S&P / Russell
  // 0.1); spreads = a typical index CFD / perp quote (Nasdaq ~2 points, S&P ~0.5, Dow ~3, Russell ~0.4).
  { id: 'NDXUSD', label: 'Nasdaq 100', yahoo: 'NQ=F', pip: 1, spreadPips: 2, kind: 'index' },
  { id: 'SPXUSD', label: 'S&P 500', yahoo: 'ES=F', pip: 0.1, spreadPips: 5, kind: 'index' },
  { id: 'DJIUSD', label: 'Dow 30', yahoo: 'YM=F', pip: 1, spreadPips: 3, kind: 'index' },
  { id: 'RUTUSD', label: 'Russell 2000', yahoo: 'RTY=F', pip: 0.1, spreadPips: 4, kind: 'index' },
  // v22: crypto majors against the dollar (Yahoo spot candles, 24/7). Spreads = a typical perp / exchange taker cost.
  { id: 'BTCUSD', label: 'BTC/USD', yahoo: 'BTC-USD', pip: 1, spreadPips: 25, kind: 'crypto' },
  { id: 'ETHUSD', label: 'ETH/USD', yahoo: 'ETH-USD', pip: 0.1, spreadPips: 15, kind: 'crypto' },
  { id: 'SOLUSD', label: 'SOL/USD', yahoo: 'SOL-USD', pip: 0.01, spreadPips: 6, kind: 'crypto' },
  // v24 (owner: "crypto more hardworking"): five more liquid majors on Coinbase; spreads ≈ 0.08–0.1% (a touch wider than the top three)
  { id: 'XRPUSD', label: 'XRP/USD', yahoo: 'XRP-USD', pip: 0.0001, spreadPips: 5, kind: 'crypto' },
  { id: 'DOGEUSD', label: 'DOGE/USD', yahoo: 'DOGE-USD', pip: 0.00001, spreadPips: 15, kind: 'crypto' },
  { id: 'ADAUSD', label: 'ADA/USD', yahoo: 'ADA-USD', pip: 0.0001, spreadPips: 5, kind: 'crypto' },
  { id: 'LINKUSD', label: 'LINK/USD', yahoo: 'LINK-USD', pip: 0.001, spreadPips: 10, kind: 'crypto' },
  { id: 'AVAXUSD', label: 'AVAX/USD', yahoo: 'AVAX-USD', pip: 0.001, spreadPips: 15, kind: 'crypto' },
];

/** v22: a crypto market (always open, priced in USD, 1 unit = 1 coin). */
export const isCrypto = (id: string) => INSTRUMENTS.some((i) => i.id === id && i.kind === 'crypto');
/** v22: crypto limits — coins move 3–5× what a currency pair does, so leverage is capped whatever the risk mode */
export const CRYPTO = { maxLeverage: 20 };

export const instrument = (id: string) => INSTRUMENTS.find((x) => x.id === id) ?? null;

/** v27: a US stock index market. */
export const isIndex = (id: string) => INSTRUMENTS.some((i) => i.id === id && i.kind === 'index');
/** v27: a market tested on a CME future (metals + indices): no currency strength / positioning, no Dukascopy / Pyth /
 * streamed price (Yahoo's futures quotes are delayed; the REST quote says by how much), the CME daily halt hour. */
export const isFutures = (id: string) => id.startsWith('XA') || isIndex(id);
/** v27: indices move ~1% a day like gold but gap on earnings / macro surprises — leverage capped whatever the risk mode */
export const INDEX = { maxLeverage: 50 };
/** v27: the most leverage a market allows (coins 20×, indices 50×, else the risk mode decides). */
export const maxLeverageFor = (id: string) => (isCrypto(id) ? CRYPTO.maxLeverage : isIndex(id) ? INDEX.maxLeverage : Infinity);
/** v27: price decimals for display: currency pairs to a tenth of a pip, indices to the quarter point, others to the pip. */
export function digitsOf(id: string): number {
  const i = instrument(id);
  if (!i) return id.includes('JPY') ? 3 : 5;
  if (i.kind === 'index') return 2;
  const d = Math.max(0, Math.round(-Math.log10(i.pip)));
  return i.kind === 'fx' ? d + 1 : d;
}

/** v13: extra crosses read ONLY for the currency strength meter (not traded). */
export const STRENGTH_PAIRS: Array<{ id: string; yahoo: string }> = [
  { id: 'AUDJPY', yahoo: 'AUDJPY=X' },
  { id: 'CADJPY', yahoo: 'CADJPY=X' },
  { id: 'NZDJPY', yahoo: 'NZDJPY=X' },
  { id: 'CHFJPY', yahoo: 'CHFJPY=X' },
  { id: 'EURAUD', yahoo: 'EURAUD=X' },
  { id: 'EURCAD', yahoo: 'EURCAD=X' },
  { id: 'GBPCHF', yahoo: 'GBPCHF=X' },
  { id: 'GBPAUD', yahoo: 'GBPAUD=X' },
];

/** v13: the wider market the bot reads for its "mood" (risk-on / risk-off). Stored as `fx:bars:mood:<id>`. */
export const MOOD_SYMBOLS: Array<{ id: 'DXY' | 'US10Y' | 'SPX' | 'VIX' | 'OIL'; yahoo: string; label: string }> = [
  { id: 'DXY', yahoo: 'DX-Y.NYB', label: 'US dollar index' },
  { id: 'US10Y', yahoo: '^TNX', label: 'US 10-year yield' },
  { id: 'SPX', yahoo: 'ES=F', label: 'S&P 500 futures' },
  { id: 'VIX', yahoo: '^VIX', label: 'VIX fear index' },
  { id: 'OIL', yahoo: 'CL=F', label: 'Oil (WTI)' },
];

/** The two sides of a market for exposure / strength (metals: XAU or XAG against USD). */
export const legsOf = (pair: string): [string, string] => [pair.slice(0, 3), pair.slice(3, 6)];

export type Timeframe = '1m' | '15m' | '1h' | '4h';
/** v15: minutes per bar */
export const TF_MIN: Record<Timeframe, number> = { '1m': 1, '15m': 15, '1h': 60, '4h': 240 };

export interface Signal {
  side: 1 | -1;
  /** stop price */
  stop: number;
  /** take-profit price; null = only trail / time exit */
  target: number | null;
  /** trail the stop this many ATR behind the best close (null = no trail) */
  trailAtr?: number | null;
  /** close after this many bars */
  maxBars?: number;
  /** close when this returns true at a bar close (mean-reversion exits) */
  exitWhen?: 'aboveSma5' | 'midBand' | 'ema20' | null;
  /** v14: move the stop to break-even (entry + costs) once price is this many R in profit */
  beAtR?: number | null;
  /** v14: take `scaleFrac` of the position off at this many R in profit, then stop to break-even */
  scaleAtR?: number | null;
  scaleFrac?: number;
  /** v15: trailing take-profit — when the target is reached the trade is not closed: `tpFrac` of it is taken off
   * (0 = none), the stop locks `tpTrail` ATR behind the target and then trails that far behind the best close */
  tpTrail?: number | null;
  tpFrac?: number;
  /** v15.1: trailing stop-loss — from the entry on, the stop follows the best close at this many R (starting stop
   * distances) behind it: it moves up with the trade, never back */
  trailR?: number | null;
  /** v27.74: plain words for the bot log (which rule fired — the level trades carry it) */
  note?: string;
}

export interface Trade {
  strategy: string;
  tf: Timeframe;
  pair: string;
  side: 1 | -1;
  entryT: number;
  /** v15.3: identity time = the signal bar's close (= entryT unless the bar after the signal is missing) */
  keyT?: number;
  exitT: number;
  entry: number;
  exit: number;
  /** result in R (1R = the distance to the initial stop), after spread */
  r: number;
  /** stop distance as % of price — sets the leverage needed */
  stopPct: number;
  /** v18: R earned (+) or paid (−) as overnight financing while held — part of `r` (financing.ts) */
  fin?: number;
  reason: 'stop' | 'target' | 'trail' | 'time' | 'exit' | 'open' | 'breakeven' | 'weekend';
  bars: number;
  /** stop at the end (trailed) / at entry, and the target */
  stop: number;
  stop0: number;
  target: number | null;
  /** v13: ATR at the signal ÷ its median over the 100 bars before (1 = normal, 2 = twice as wild) */
  volRatio?: number;
  /** v14: price that moves the stop to break-even, price where part is taken off (and how much), and whether it was */
  beAt?: number;
  scaleAt?: number;
  scaleFrac?: number;
  scaled?: boolean;
  /** v15: trailing take-profit — the stop's distance behind the target at the switch (price), the share taken off at
   * the target, and whether the target was reached (then `target` is null and the stop trails) */
  tpTrailPx?: number;
  tpFrac?: number;
  tpHit?: boolean;
  /** v15: the target at entry, kept once a trailing take-profit replaced it */
  target0?: number | null;
  /** v15: the exit rules still in force on an OPEN trade (for the bot's plan): trail ATR, bar limit, indicator exit,
   * (v15.1) the trailing stop-loss distance in price */
  trailPx?: number;
  trailAtr?: number;
  maxBars?: number;
  exitWhen?: string;
}
