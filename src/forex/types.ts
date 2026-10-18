/** Forex lab (v12): shared types + the instrument list. Prices are plain quotes (EUR/USD 1.0842, gold 2,650.4). */

export interface Bar {
  /** bar open time, ms UTC */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
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
  kind: 'fx' | 'metal';
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
  { id: 'XAUUSD', label: 'Gold', yahoo: 'GC=F', pip: 0.01, spreadPips: 30, kind: 'metal' },
  { id: 'XAGUSD', label: 'Silver', yahoo: 'SI=F', pip: 0.001, spreadPips: 30, kind: 'metal' },
];

export const instrument = (id: string) => INSTRUMENTS.find((x) => x.id === id) ?? null;

/** v13: extra crosses read ONLY for the currency strength meter (not traded). */
export const STRENGTH_PAIRS: Array<{ id: string; yahoo: string }> = [
  { id: 'AUDJPY', yahoo: 'AUDJPY=X' },
  { id: 'CADJPY', yahoo: 'CADJPY=X' },
  { id: 'NZDJPY', yahoo: 'NZDJPY=X' },
  { id: 'CHFJPY', yahoo: 'CHFJPY=X' },
  { id: 'EURAUD', yahoo: 'EURAUD=X' },
  { id: 'EURCHF', yahoo: 'EURCHF=X' },
  { id: 'EURCAD', yahoo: 'EURCAD=X' },
  { id: 'GBPCHF', yahoo: 'GBPCHF=X' },
  { id: 'GBPAUD', yahoo: 'GBPAUD=X' },
  { id: 'AUDNZD', yahoo: 'AUDNZD=X' },
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
}

export interface Trade {
  strategy: string;
  tf: Timeframe;
  pair: string;
  side: 1 | -1;
  entryT: number;
  exitT: number;
  entry: number;
  exit: number;
  /** result in R (1R = the distance to the initial stop), after spread */
  r: number;
  /** stop distance as % of price — sets the leverage needed */
  stopPct: number;
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
  /** v15: the exit rules still in force on an OPEN trade (for the bot's plan): trail ATR, bar limit, indicator exit */
  trailAtr?: number;
  maxBars?: number;
  exitWhen?: string;
}
