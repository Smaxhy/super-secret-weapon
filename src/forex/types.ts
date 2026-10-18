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

export type Timeframe = '1h' | '4h';

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
  reason: 'stop' | 'target' | 'trail' | 'time' | 'exit' | 'open';
  bars: number;
}
