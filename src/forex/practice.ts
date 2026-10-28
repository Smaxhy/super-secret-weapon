/**
 * Forex practice account (v12.1): the owner trades by hand with fake money, live prices and leverage. Prices = Yahoo
 * 1-minute bars (refreshed ≤ every 15 s while used), bid / ask = mid ∓ half the instrument's spread. Margin = notional /
 * leverage; a position's P&L is converted to USD; when equity falls to `stopOutPct` of the margin in use everything is
 * closed (a broker stop-out). Stops / targets are checked against every 1-minute high / low since the last check.
 * Redis `fx:practice` (one account). Nothing here touches a real broker.
 */
import { feePctPerSide, feePxOf, feeUsd } from './venue-fees';
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { bus, type FxNotice } from '../lib/bus';
import { feeds } from './feeds';
import { dkQuote } from './dukascopy';
import { HEAT, maxRiskUnder, topCorrelated, type CorrBook } from './risk';
import { oandaCandles, oandaCovers, oandaPrices, oandaReady, loadOanda, type Granularity, type OandaSettings } from './oanda';
import { BASIS, liveTail, measureBasis, needsBasis, shiftBars, type BasisRow } from './basis';
import { hlCandles, hyperliquidLive } from './hyperliquid';
import { INSTRUMENTS, TF_MIN, instrument, isCrypto, isFutures, maxLeverageFor, type Bar, type Instrument, type Timeframe } from './types';
import { clockFor, marketClock } from './calendar';
import { priceShock } from './headlines';
import { spreadMultAt } from './spreads';
import { SIZING, addExposure, clampRisk, ddFactor, exposureBlock, type Exposure } from './portfolio';
import type { Tier } from './conviction';
import { SNIPER } from './sniper';
import { parsePnlRow, pnlRowOf, type PnlRow } from './pnl';
import { liveFeed } from './live-feed';
import { COPY_LOCK, lockedStop, lockPlanNet, PROFIT_LOCK, type LockPlan } from './profit-lock';
import { FINANCING, rollsBetween, swapGain } from './financing';
import type { LiveTick } from './pyth';
import { tradesNews } from './strategies';
import { DISCORD_COPY, copySize, copyStop, type CopyBook } from './discord';

const log = moduleLogger('forex-practice');
/** 'me' = the owner's own practice account, 'bot' = the forex auto-bot, 'cbot' (v22.1) = the coin auto-bot */
export type AcctId = 'me' | 'bot' | 'cbot';
const keyFor = (a: AcctId) => (a === 'me' ? 'fx:practice' : a === 'cbot' ? 'fx:practice:cbot' : 'fx:practice:bot');
/** v17.8: durable P&L log per account (one JSON row per booked close, newest 20,000) — the calendar / P&L views read it */
export const pnlKey = (a: AcctId) => `fx:pnl:${a}`;
export const PNL_KEEP = 20_000;
/** v17.8: closes booked on an account object since its last save — that save writes them to the log in the same Redis
 * transaction as the account (so a close is in the log exactly when it is in the stored account), then forgets them */
const pnlQueue = new WeakMap<PracticeAccount, PnlRow[]>();
/** v17.12: phone alerts waiting for the account's next save (published once it is written) */
const noticeQueue = new WeakMap<PracticeAccount, FxNotice[]>();
function notice(a: PracticeAccount, n: FxNotice): void {
  const q = noticeQueue.get(a);
  if (q) q.push(n);
  else noticeQueue.set(a, [n]);
}
/** The alerts gathered on this account object since the last call (and clears them). */
export function takeNotices(a: PracticeAccount): FxNotice[] {
  const q = noticeQueue.get(a) ?? [];
  noticeQueue.delete(a);
  return q;
}

function logClose(a: PracticeAccount, c: ClosedPractice): void {
  const q = pnlQueue.get(a);
  if (q) q.push(pnlRowOf(c));
  else pnlQueue.set(a, [pnlRowOf(c)]);
}
/** Bot account: base risk per trade (% of equity), leverage used, most positions at once, most risk on one currency. */
export const BOT = {
  riskPct: SIZING.baseRiskPct,
  leverage: SIZING.leverage,
  maxOpen: SIZING.maxOpen,
  freshMs: 2 * 3_600_000,
  maxCcyRiskPct: SIZING.ccyCapPct,
  /** v15: how old a lab trade may be when the bot first sees it, per chart (a 1-minute signal is stale in 2 minutes) */
  freshMsByTf: { '1m': 2 * 60_000, '15m': 20 * 60_000, '1h': 2 * 3_600_000, '4h': 2 * 3_600_000 } as Record<string, number>,
  /** v15: most open bot trades per chart, so the fast charts can't take every slot */
  maxOpenByTf: { '1m': 2, '15m': 3 } as Record<string, number>,
  /** v17: no new bot trade when the price already moved this many R (starting stop distances) its way since the lab's fill */
  maxEntryDriftR: 0.3,
  /** v17: the price a new bot trade opens on may be at most this old, per chart (a 1-minute trade needs a fresh price) */
  quoteAgeMsByTf: { '1m': 2 * 60_000, '15m': 5 * 60_000, '1h': 10 * 60_000, '4h': 10 * 60_000 } as Record<string, number>,
  /** v27.18: Yahoo's CME futures (indices, metals) arrive ~10 min late but often don't declare it (exchangeDataDelayedBy 0) —
   * an hourly / 4-hour trade on one may use this much delay on top of the limit when the feed declares none */
  futuresDelayMs: 15 * 60_000,
  /** v27.20: the most a single trade may lose, per account (the coin bot: $20; v27.22 the forex bot too) */
  maxLossUsdByAcct: { cbot: 50, bot: 20 } as Partial<Record<string, number>>,
  /** v27.78 (owner raised the coin bot's cap to $50: "LINK usually does better"): on these accounts the excursion study's
   * per-strategy cap (kept $10–40) may not pull a trade in tighter than the account's cap — the owner's number is the floor */
  capFloorAccts: { cbot: true } as Partial<Record<string, boolean>>,
  /** v27.38 (owner: "max 5–10 trades per day"): new trades a bot may open per trading day (from 22:00 UTC = midnight
   * Central European summer time). The best-tested signals go first (`prio`); a weekend re-open of a paused trade is not
   * a new trade. 0 = no cap. */
  maxTradesPerDay: { bot: SIZING.maxPerDay, cbot: 0 } as Partial<Record<string, number>>,
  /** v27.42 (owner: "15 trades max … so it can still trade throughout the day, not 18 trades at night all at once"): new
   * trades a bot may open in any rolling hour. 0 = no cap. v27.49 (owner: "turn it off"): both coin caps OFF — the shadow
   * book had 46 trades held back by them at 89% won / +29.6R; `maxSameSide` 2 still stops a same-way burst. */
  maxTradesPerHour: { cbot: 0 } as Partial<Record<string, number>>,
  /** v27.26 (owner: "if it happens trade it with extreme size, up to 20% of the wallet"): per account, a strategy:chart
   * that trades at this % of the account at its TESTED stop — past the risk mode, the currency / correlated-risk caps and
   * the $ loss cap (its stop is the strategy's own). All such trades together never risk more than that %. */
  allIn: {} as Partial<Record<string, Record<string, number>>>,
  /** v27.26: an all-in trade may use up to this share of the free margin (normal trades: SIZING.marginShare) */
  allInMarginShare: 0.9,
  /** v27.23: one open trade (or resting order) per market and direction across all strategies — no doubled bets */
  onePerMarketSide: true,
  /** v27.44 (owner: "make it trade smarter … what it just did is an account drainer"; Oct 25 06:00 UTC it shorted BTC, XRP,
   * SOL, LINK at once — coins move together, so that was one bet placed six times): at most this many open trades (+ resting
   * orders) in the same direction across the whole account; the best-tested signals go first. 0 = no cap. */
  maxSameSide: { cbot: 2 } as Partial<Record<string, number>>,
  /** v27.24 (owner: "every bot can lose but 4 losses in a row is different"): 3 bot losses in a row → half size until a
   * win; 4 → no new trades for `pauseHours` after the last one (a safety rule, not graded — like the VIX brake).
   * v27.25 OFF (owner: "there doesn't have to be a cooling-off system, just a max loss system") — the per-trade loss
   * cap (`maxLossUsdByAcct`) is the only loss rule; `on: true` restores the brake */
  streak: { on: false, halveAt: 3, pauseAt: 4, pauseHours: 4, factor: 0.5 },
  /** v18.7 (owner: "wait it out, then adjust"): after a strategy closes a trade on a market, the same strategy may not
   * re-enter that market for this many candles of its chart (3 h on the hourly, 12 h on the 4-hour) */
  reentryCooldownBars: 3,
  /** v26.2: a held trade whose lab trade vanished WITHOUT finishing (a re-test changed the strategy's filter / exit) is kept
   * and run by its own stop / target / profit lock — closed after this many candles of its chart if nothing else ends it */
  orphanMaxBars: 30,
  /** v27.79 (owner: "only take trades if you're certain … it needs to adjust itself properly"): on these accounts a trade's
   * size is cut so its TESTED stop loses at most the account's $ cap (× `headroom` for the exit spread) — the stop is never
   * pulled in, so the live trade is the one the lab graded */
  sizeToCap: { cbot: true } as Partial<Record<string, boolean>>,
  sizeToCapHeadroom: 0.95,
  /** v27.79: a strategy × chart whose own live trades (closed since `since`, the last `days`) lost money after `minN` of
   * them is paused on that account until those trades are older than `days` — lab evidence alone isn't "sure" */
  liveBrake: { cbot: { since: Date.parse('2026-10-28T12:00:00Z'), minN: 3, days: 14 } } as Partial<Record<string, { since: number; minN: number; days: number }>>,
};

/** v27.79: the live brake for one strategy × chart from its R-ledger rows: paused when `minN`+ trades closed since
 * `since` within the last `days` made less than 0R together; `until` = when the oldest of them ages out. Pure. */
export function liveBrake(rows: readonly LedgerRow[] | undefined, now: number, cfg: { since: number; minN: number; days: number }): { n: number; r: number; paused: boolean; until: number | null } {
  const from = Math.max(cfg.since, now - cfg.days * 86_400_000);
  const recent = (rows ?? []).filter((x) => x[0] >= from && x[2] !== null && x[4] !== LEDGER_WHY.manual).sort((x, y) => x[0] - y[0]);
  const r = Math.round(recent.reduce((n, x) => n + (x[2] ?? 0), 0) * 100) / 100;
  const paused = recent.length >= cfg.minN && r < 0;
  return { n: recent.length, r, paused, until: paused ? recent[0]![0] + cfg.days * 86_400_000 : null };
}

/** v18.7: minutes until the same strategy may trade the same market again after `closed`, or 0 when it may now */
export function reentryWait(closed: readonly ClosedPractice[], strategy: string, tf: string, pair: string, now: number, bars = BOT.reentryCooldownBars): number {
  const ms = bars * (TF_MIN[tf as Timeframe] ?? 60) * 60_000;
  let wait = 0;
  for (const c of closed) {
    if (c.pair !== pair || c.strategy !== strategy || (c.tf ?? c.ref?.split(':')[1]) !== tf) continue;
    if (c.reason === 'partial' || c.reason === 'weekend') continue; // the trade itself is still running / paused
    const left = c.closedAt + ms - now;
    if (left > wait) wait = left;
  }
  return Math.ceil(wait / 60_000);
}
/**
 * v15.6 (owner: "I need a lot more, at least 10%+ a month"): how hard the bot account trades. Same strategies and checks in
 * every mode — only the risk per trade, leverage and how many trades may be open at once grow. Bigger months AND bigger
 * losing months: the honest test shows each level's real weekly / monthly spread before you pick one.
 */
export type RiskMode = 'normal' | 'aggressive' | 'max' | 'turbo';
export interface RiskLimits {
  label: string;
  /** base risk per trade, % of equity */
  riskPct: number;
  leverage: number;
  maxOpen: number;
  /** most risk on one currency in one direction, % of equity */
  ccyCapPct: number;
  maxPerStrategy: number;
  /** most risk one 'sure' / 'very sure' trade may carry, % of equity */
  convMaxRiskPct: number;
  /** most open trades per fast chart */
  maxOpenByTf: Record<string, number>;
  /** v17: most combined stop-risk of trades that move together (√ r'Cr), % of equity — used once the honest test proves it */
  heatCapPct: number;
}
export const RISK_MODES: Record<RiskMode, RiskLimits> = {
  normal: { label: 'Normal', riskPct: 1, leverage: 30, maxOpen: 8, ccyCapPct: 2.2, maxPerStrategy: 3, convMaxRiskPct: 2, maxOpenByTf: { '1m': 2, '15m': 3 }, heatCapPct: 3 },
  aggressive: { label: 'Aggressive', riskPct: 3, leverage: 100, maxOpen: 12, ccyCapPct: 6.6, maxPerStrategy: 4, convMaxRiskPct: 5, maxOpenByTf: { '1m': 3, '15m': 5 }, heatCapPct: 9 },
  max: { label: 'Max', riskPct: 5, leverage: 200, maxOpen: 15, ccyCapPct: 11, maxPerStrategy: 5, convMaxRiskPct: 8, maxOpenByTf: { '1m': 4, '15m': 6 }, heatCapPct: 15 },
  // v26.5 (owner: "use more risk"): 8% a trade — 9 losers in a row halve the account
  turbo: { label: 'Turbo', riskPct: 8, leverage: 500, maxOpen: 15, ccyCapPct: 17, maxPerStrategy: 5, convMaxRiskPct: 12, maxOpenByTf: { '1m': 4, '15m': 6 }, heatCapPct: 24 },
};
export const isRiskMode = (m: unknown): m is RiskMode => m === 'normal' || m === 'aggressive' || m === 'max' || m === 'turbo';
export const limitsFor = (m: RiskMode | undefined): RiskLimits => RISK_MODES[m ?? 'normal'] ?? RISK_MODES.normal;

/** The chart of a bot trade from its lab ref (`strategy:tf:pair:entryT`). */
export const tfOfRef = (ref: string | undefined) => (ref ? ref.split(':')[1] ?? '' : '');
export const STOP_OUT_PCT = 50;
export const MAX_LEVERAGE = 500;

export interface Quote {
  id: string;
  /** last mid price */
  mid: number;
  bid: number;
  ask: number;
  t: number;
  /** recent 1-minute bars (t, h, l, c[, o]), oldest first — v17: the open (when the source gives it) fills gaps honestly */
  bars: Array<[number, number, number, number, number?]>;
  dayChangePct: number | null;
  /** where the price came from (v17: Dukascopy = the backup when Yahoo fails, currency pairs only) */
  source: 'oanda' | 'yahoo' | 'dukascopy' | 'pyth' | 'yahoo-live' | 'hyperliquid';
  barsAt?: number;
  /** v17.9: yesterday's close (Yahoo) — the day change of a live Pyth price */
  prevClose?: number;
  /** broker time of the price (v17: Yahoo too — its market time) */
  priceT?: number;
  tradeable?: boolean;
  /** v17: an older cached price handed back because the feed failed just now */
  stale?: boolean;
  /** v17: the source says its prices are delayed this long (Yahoo's COMEX metals: ~10 min) */
  delayMs?: number;
}

/** v17: how old the price behind a quote is (ms; the broker / market time when known). Pure. */
export const quoteAge = (q: Pick<Quote, 'priceT' | 'bars' | 't'>, now: number) => now - (q.priceT ?? q.bars[q.bars.length - 1]?.[0] ?? q.t);

export interface PracticePosition {
  id: string;
  pair: string;
  side: 1 | -1;
  /** base-currency units */
  units: number;
  entry: number;
  marginUsd: number;
  leverage: number;
  stop: number | null;
  target: number | null;
  openedAt: number;
  /** last 1-minute bar already checked for stop / target */
  checkedT: number;
  /** bot trades: which strategy, and the lab trade it mirrors */
  strategy?: string;
  ref?: string;
  /** bot trades (v13): % of the account it risked at the stop */
  riskPct?: number;
  /** bot trades (v14): price that moves the stop to break-even, price where `scaleFrac` is taken off, and their state */
  beAt?: number | null;
  scaleAt?: number | null;
  scaleFrac?: number;
  scaled?: boolean;
  be?: boolean;
  /** bot trades (v15): trailing take-profit — at the target the stop locks this far behind it (price) after taking
   * `tpFrac` off, and the trade carries on with the lab's trailing stop; `tpHit` once that happened */
  tpTrailPx?: number | null;
  tpFrac?: number;
  tpHit?: boolean;
  /** bot trades (v15.2): how sure it was of the entry and what size that earned */
  conviction?: Conviction | null;
  /** bot trades (v16): opened at the sniper size (votes it had) */
  sniper?: { votes: number; of: number } | null;
  /** v20: opened by a market desk as its daily learning trade */
  desk?: boolean;
  /** v27.26: an all-in trade (`BOT.allIn`) — its own tested stop, the account's $ loss cap doesn't pull it in */
  allIn?: boolean;
  /** v27.45: this trade's own $ loss cap (from the excursion study, `Practice.slCaps`); missing = the account's */
  maxLossUsd?: number;
  /** bot trades (v15.3): USD already banked by parts taken off (and legs before a weekend pause) */
  bankedUsd?: number;
  /** v17: USD lost if the stop is hit, measured on the real fill when it opened (1 R) */
  riskUsd0?: number;
  /** v17: closing was asked for while there was no price — it closes at the first price that arrives */
  closePending?: { reason: 'signal' | 'manual' | 'weekend'; at: number } | null;
  /** v18 overnight financing (financing.ts): the last daily roll booked (missing = none since it opened) and the USD
   * earned (+) / paid (−) so far — inside `bankedUsd`, so it counts in the trade's total */
  swapT?: number;
  swapUsd?: number;
  /** bot trades (v15): the strategy's chart and the exit rules still in force (shown as the trade's plan); v15.1:
   * `trailPx` = the trailing stop-loss distance (price) */
  tf?: string;
  trailPx?: number | null;
  trailAtr?: number | null;
  maxBars?: number | null;
  exitWhen?: string | null;
  /** v17.11 the owner's profit lock (profit-lock.ts): its plan (null = none; missing = not worked out yet — the next
   * check does), whether it armed, the best exit-side price since, and the minute the stop was last moved in (that
   * minute's earlier low / high no longer counts against the new stop) */
  lock?: LockPlan | null;
  locked?: boolean;
  lockBest?: number | null;
  /** v27.66: a Kojiro copy held with the tight trailing stop (his record, or news right now — `tightWhy`) */
  copyLock?: 'copy' | 'tight';
  tightWhy?: string;
  stopMovedT?: number | null;
  /** v17.12: phone alerts already sent (1 = profit locked, 2 = two thirds of the way to the target) */
  alerts?: number;
}

/** v27.38: start of the bot's trading day (22:00 UTC). Pure. */
export const tradingDayStart = (now: number): number => Math.floor((now + 2 * 3_600_000) / 86_400_000) * 86_400_000 - 2 * 3_600_000;
/** v27.38: bot trades opened since the trading day began — one per trade (its first opening; parts, weekend legs and
 * the re-opened leg of a paused trade don't count again), plus resting orders placed today. Pure. */
export function tradesOpenedToday(a: { open: readonly PracticePosition[]; closed: readonly ClosedPractice[]; orders?: ReadonlyArray<{ ref?: string; placedAt: number }> }, now: number): number {
  return tradesOpenedSince(a, tradingDayStart(now));
}

/** v27.42: new trades (each ref once, by its first opening) + resting orders placed since `from`. Pure. */
export function tradesOpenedSince(a: { open: readonly PracticePosition[]; closed: readonly ClosedPractice[]; orders?: ReadonlyArray<{ ref?: string; placedAt: number }> }, from: number): number {
  const first = new Map<string, number>();
  for (const p of [...a.open, ...a.closed]) {
    if (!p.ref) continue;
    first.set(p.ref, Math.min(first.get(p.ref) ?? Infinity, p.openedAt));
  }
  let n = 0;
  for (const t of first.values()) if (t >= from) n++;
  for (const o of a.orders ?? []) if (o.placedAt >= from && (!o.ref || !first.has(o.ref))) n++;
  return n;
}

export interface ClosedPractice extends PracticePosition {
  exit: number;
  closedAt: number;
  pnlUsd: number;
  reason: 'manual' | 'stop' | 'target' | 'stop-out' | 'signal' | 'weekend' | 'partial' | 'spike';
  /** v26: the venue's open + close fee taken out of `pnlUsd` (venue-fees.ts) */
  feeUsd?: number;
}

/** v14: a bot trade paused for the weekend, re-opened after Monday's open if its lab trade is still running */
export interface ResumeItem {
  ref: string;
  strategy?: string;
  pair: string;
  side: 1 | -1;
  riskPct?: number;
  scaled?: boolean;
  /** v15: the target had been reached (part may already be off) */
  tpHit?: boolean;
  /** v15.2: its leverage (a 'sure' trade re-opens at the same size) */
  lev?: number;
  /** v15.3: USD the trade had banked before the pause (it is one trade with the re-opened leg) */
  bankedUsd?: number;
  /** v17: USD the ORIGINAL trade risked at its stop (the whole trade stays one R unit across the pause) */
  riskUsd0?: number;
  at: number;
}

/**
 * v17 bot R ledger: one finished bot trade = [closed at, total USD incl. parts taken, R (total ÷ USD at risk when it
 * opened; null when unknown), lab ref, why]. Never rewritten — the only record of what the bot itself really did.
 */
export type LedgerRow = [closedAt: number, usd: number, r: number | null, ref: string, why: number];
export const LEDGER_WHY = { stop: 0, target: 1, signal: 2, 'stop-out': 3, weekend: 4, manual: 5, spike: 6 } as const;
const LEDGER_KEEP = 60;
const LEDGER_DAYS = 120;

export interface BotLedgerRow {
  key: string;
  ref: string;
  /** the lab trade's signal-bar close */
  keyT: number;
  closedAt: number;
  usd: number;
  r: number | null;
  why: number;
}

export interface PracticeAccount {
  startUsd: number;
  balanceUsd: number;
  /** v13: highest equity seen (the bot trades smaller after a drop) */
  peakUsd?: number;
  /** v14: trades closed for the weekend, waiting to be re-opened */
  resume?: ResumeItem[];
  /** v15.3: finished bot trades per strategy and chart (`ema_cross:1h`): [closed at, total USD incl. parts taken] — the
   * newest 40 each, so the bot's own record never depends on how many other trades scrolled the history */
  stats?: Record<string, Array<[number, number]>>;
  /** v15.6: bot account only — how hard it trades (default normal) */
  riskMode?: RiskMode;
  /** v17: finished bot trades in R per strategy and chart (newest 60, ≤ 120 days) */
  ledger?: Record<string, LedgerRow[]>;
  /** v27.22: lab trades (refs) the owner had struck — the bot never opens them again (newest 50) */
  skipRefs?: string[];
  /** v17.11: the owner's profit lock on this account's trades (missing = on) */
  profitLock?: boolean;
  /** v27.20 (owner: "make the SL on crypto much stricter, not past $20"): no trade on this account may lose more than this
   * many USD — the size stays the risk mode's (owner: "still turbo, just a tighter SL"); every trade's stop is pulled in
   * to this loss (never loosened). Set by syncBot from `BOT.maxLossUsdByAcct`. */
  maxLossUsd?: number;
  /** v18.4: bot account — resting limit orders waiting to fill */
  orders?: RestingOrder[];
  open: PracticePosition[];
  closed: ClosedPractice[];
  createdAt: number;
}

export const newAccount = (startUsd = 1000): PracticeAccount => ({ startUsd, balanceUsd: startUsd, open: [], closed: [], stats: {}, createdAt: Date.now() });

/** Value of 1 unit of `ccy` in USD from the latest mids. Pure. */
export function usdPer(ccy: string, mids: Record<string, number>): number | null {
  if (ccy === 'USD') return 1;
  const direct = mids[`${ccy}USD`];
  if (direct) return direct;
  const inverse = mids[`USD${ccy}`];
  if (inverse) return 1 / inverse;
  return null;
}
const baseOf = (i: Instrument) => (i.kind === 'metal' ? i.id.slice(0, 3) : i.id.slice(0, 3));
const quoteOf = (i: Instrument) => i.id.slice(3, 6);

/** Units of base for a USD notional. Metals: 1 unit = 1 oz priced in USD; coins (v22): 1 unit = 1 coin in USD. Pure. */
export function unitsFor(inst: Instrument, notionalUsd: number, mids: Record<string, number>): number | null {
  if (inst.kind !== 'fx') return notionalUsd / mids[inst.id]!;
  const b = usdPer(baseOf(inst), mids);
  return b ? notionalUsd / b : null;
}

/** P&L in USD of a position at `px`. Pure. */
export function pnlUsd(p: Pick<PracticePosition, 'pair' | 'side' | 'units' | 'entry'>, px: number, mids: Record<string, number>): number {
  const inst = instrument(p.pair)!;
  const inQuote = p.side * p.units * (px - p.entry);
  if (inst.kind !== 'fx') return inQuote;
  const q = usdPer(quoteOf(inst), { ...mids, [inst.id]: px });
  return q ? inQuote * q : 0;
}

/** Exit price for a position given a mid (sell at bid when long, buy at ask when short). Pure. */
export function exitPx(p: Pick<PracticePosition, 'pair' | 'side'>, mid: number, half?: number): number {
  const inst = instrument(p.pair)!;
  return mid - p.side * (half ?? (inst.spreadPips * inst.pip) / 2);
}

/** Risk (USD lost if the stop is hit) of an open position; 0 when the stop already locks in a profit. Pure. */
export function positionRiskUsd(p: Pick<PracticePosition, 'pair' | 'side' | 'units' | 'entry' | 'stop'>, mids: Record<string, number>): number {
  if (p.stop === null) return 0;
  return Math.max(0, -pnlUsd(p, p.stop, mids));
}

/** Signed risk per currency, % of equity (buying EUR/USD = +EUR, −USD). Pure. */
export function currencyExposure(open: ReadonlyArray<Pick<PracticePosition, 'pair' | 'side' | 'units' | 'entry' | 'stop'>>, mids: Record<string, number>, equityUsd: number): Exposure {
  const exp: Exposure = {};
  if (!(equityUsd > 0)) return exp;
  for (const p of open) addExposure(exp, p.pair, p.side, (positionRiskUsd(p, mids) / equityUsd) * 100);
  return exp;
}

export interface RiskSummary {
  /** signed risk per currency, % of equity, biggest first */
  exposure: Array<{ ccy: string; pct: number }>;
  capPct: number;
  /** equity under its peak, % */
  ddPct: number;
  /** size multiplier that drop applies to new trades */
  ddFactor: number;
  baseRiskPct: number;
  /** total risk if every stop were hit, % of equity */
  openRiskPct: number;
}

/** The bot account's risk picture (for the dashboard). Pure. */
export function riskSummary(a: Pick<PracticeAccount, 'open' | 'peakUsd' | 'startUsd' | 'riskMode'>, mids: Record<string, number>, equityUsd: number): RiskSummary {
  const exp = currencyExposure(a.open, mids, equityUsd);
  const peak = Math.max(a.peakUsd ?? a.startUsd, equityUsd);
  const ddPct = peak > 0 ? Math.max(0, (1 - equityUsd / peak) * 100) : 0;
  const openRisk = equityUsd > 0 ? a.open.reduce((s, p) => s + positionRiskUsd(p, mids), 0) / equityUsd * 100 : 0;
  return {
    exposure: Object.entries(exp)
      .filter(([, v]) => Math.abs(v) >= 0.01)
      .map(([ccy, v]) => ({ ccy, pct: Math.round(v * 100) / 100 }))
      .sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct)),
    capPct: limitsFor(a.riskMode).ccyCapPct,
    ddPct: Math.round(ddPct * 10) / 10,
    ddFactor: ddFactor(ddPct),
    baseRiskPct: limitsFor(a.riskMode).riskPct,
    openRiskPct: Math.round(openRisk * 100) / 100,
  };
}

export interface AccountView extends PracticeAccount {
  equityUsd: number;
  marginUsedUsd: number;
  freeMarginUsd: number;
  /** equity / margin in use, % (null when flat) */
  marginLevelPct: number | null;
  positions: Array<PracticePosition & { px: number; pnlUsd: number; pnlPct: number; /** v17.9: USD per 1.0 move of the exit price */ pnlPerPx?: number; /** v27.75: age of the price behind px (ms) */ priceAgeMs?: number }>;
}

export function view(a: PracticeAccount, mids: Record<string, number>, halves: Record<string, number> = {}): AccountView {
  const positions = a.open.map((p) => {
    const mid = mids[p.pair] ?? p.entry;
    const px = exitPx(p, mid, halves[p.pair]);
    // v26.2 (owner: "it was up $10 then sold for $1"): the open P&L already counts the venue fee the close will charge, so
    // the number on screen is what closing now would really book
    const pl = pnlUsd(p, px, mids) - feeUsd(instrument(p.pair) ?? { id: p.pair, kind: 'fx' }, p.marginUsd, p.leverage);
    // v17.9: USD per 1.0 move of the exit price (the dashboard moves P&L with live ticks between refreshes)
    const h = instrument(p.pair)?.pip ?? 0.0001;
    const pnlPerPx = (pnlUsd(p, px + h, mids) - pnlUsd(p, px - h, mids)) / (2 * h);
    return { ...p, px, pnlUsd: Math.round(pl * 100) / 100, pnlPct: Math.round((pl / p.marginUsd) * 1000) / 10, pnlPerPx: Number(pnlPerPx.toPrecision(8)) };
  });
  const upnl = positions.reduce((s, p) => s + p.pnlUsd, 0);
  const used = a.open.reduce((s, p) => s + p.marginUsd, 0);
  const equity = a.balanceUsd + upnl;
  return { ...a, equityUsd: Math.round(equity * 100) / 100, marginUsedUsd: Math.round(used * 100) / 100, freeMarginUsd: Math.round((equity - used) * 100) / 100, marginLevelPct: used > 0 ? Math.round((equity / used) * 1000) / 10 : null, positions };
}

/** `strategy:chart` of a bot trade (null for manual ones). */
export const statKey = (p: Pick<PracticePosition, 'strategy' | 'tf' | 'ref'>) => (p.strategy ? `${p.strategy}:${p.tf ?? (tfOfRef(p.ref) || '1h')}` : null);
const STATS_KEEP = 40;

/** Older accounts: rebuild the per strategy:chart record from the closed list once. Mutates `a`. */
function ensureStats(a: PracticeAccount): Record<string, Array<[number, number]>> {
  if (a.stats) return a.stats;
  const st: Record<string, Array<[number, number]>> = {};
  for (const c of [...a.closed].reverse()) {
    const k = statKey(c);
    if (!k || c.reason === 'partial' || c.reason === 'weekend') continue;
    (st[k] = st[k] ?? []).push([c.closedAt, c.pnlUsd]);
  }
  for (const k of Object.keys(st)) st[k] = st[k]!.slice(-STATS_KEEP);
  a.stats = st;
  return st;
}

/**
 * Record one finished bot trade (its total, parts included). v17: with `extra.ref` it also joins the R ledger
 * (R = total ÷ the USD it risked when it opened). Mutates `a`.
 */
export function recordTrade(a: PracticeAccount, key: string | null, at: number, usd: number, extra?: { ref?: string; riskUsd0?: number; why: keyof typeof LEDGER_WHY }): void {
  if (!key) return;
  const st = ensureStats(a);
  st[key] = [...(st[key] ?? []), [at, Math.round(usd * 100) / 100] as [number, number]].slice(-STATS_KEEP);
  if (!extra?.ref) return;
  const r = extra.riskUsd0 && extra.riskUsd0 > 0 ? Math.round((usd / extra.riskUsd0) * 1000) / 1000 : null;
  const led = (a.ledger = a.ledger ?? {});
  led[key] = [...(led[key] ?? []).filter((x) => at - x[0] <= LEDGER_DAYS * 86_400_000), [at, Math.round(usd * 100) / 100, r, extra.ref, LEDGER_WHY[extra.why]] as LedgerRow].slice(-LEDGER_KEEP);
}

/** v17: the bot's ledger as rows (newest last). Pure. */
export function ledgerRows(a: PracticeAccount): BotLedgerRow[] {
  const out: BotLedgerRow[] = [];
  for (const [key, rows] of Object.entries(a.ledger ?? {})) {
    for (const [closedAt, usd, r, ref, why] of rows) out.push({ key, ref, keyT: Number(ref.split(':')[3]) || 0, closedAt, usd, r, why });
  }
  return out.sort((x, y) => x.closedAt - y.closedAt);
}

/** v17: per strategy:chart — trades with a known R, total R, average R, wins (manual closes left out). Pure. */
export function ledgerSummary(a: PracticeAccount): Record<string, { n: number; totalR: number; avgR: number; wins: number }> {
  const out: Record<string, { n: number; totalR: number; avgR: number; wins: number }> = {};
  for (const x of ledgerRows(a)) {
    if (x.r === null || x.why === LEDGER_WHY.manual) continue;
    const s = (out[x.key] = out[x.key] ?? { n: 0, totalR: 0, avgR: 0, wins: 0 });
    s.n++;
    s.totalR += x.r;
    if (x.r > 0) s.wins++;
  }
  for (const s of Object.values(out)) {
    s.totalR = Math.round(s.totalR * 100) / 100;
    s.avgR = Math.round((s.totalR / s.n) * 100) / 100;
  }
  return out;
}

/**
 * v18.8 (owner: "revert those trades as if it never happened"): strike every trade of one chart from an account —
 * closed rows (their USD taken back out of the balance), parts, open positions (nothing was booked for them), resting
 * orders, weekend pauses, and the chart's record / R ledger keys. Returns what was removed. Mutates `a`. Pure.
 */
export function undoChart(a: PracticeAccount, tf: string): { closed: number; usd: number; open: number; orders: number } {
  const chartOf = (x: { tf?: string | null; ref?: string | null }) => x.tf ?? (x.ref ? tfOfRef(x.ref) : '');
  const gone = a.closed.filter((c) => chartOf(c) === tf);
  const usd = Math.round(gone.reduce((n, c) => n + c.pnlUsd, 0) * 100) / 100;
  a.closed = a.closed.filter((c) => chartOf(c) !== tf);
  a.balanceUsd = Math.round((a.balanceUsd - usd) * 100) / 100;
  const open = a.open.filter((p) => chartOf(p) === tf).length;
  a.open = a.open.filter((p) => chartOf(p) !== tf);
  const orders = (a.orders ?? []).filter((o) => chartOf(o) === tf).length;
  if (a.orders) a.orders = a.orders.filter((o) => chartOf(o) !== tf);
  if (a.resume) a.resume = a.resume.filter((r) => tfOfRef(r.ref) !== tf);
  for (const key of Object.keys(a.stats ?? {})) if (key.endsWith(`:${tf}`)) delete a.stats![key];
  for (const key of Object.keys(a.ledger ?? {})) if (key.endsWith(`:${tf}`)) delete a.ledger![key];
  if (a.peakUsd !== undefined && usd > 0) a.peakUsd = Math.max(a.balanceUsd, a.peakUsd - usd);
  return { closed: gone.length, usd, open, orders };
}

/**
 * v27.21 (owner: "if it was a bug revert the last 3 losses"): strike chosen CLOSED trades (+ their parts) from an account
 * as if they never happened — their USD back out of the balance, their rows in the bot's record (`stats`) and R ledger.
 * Returns the ids (their P&L-log rows must go too) and the USD removed. Mutates `a`. Pure.
 */
export function undoClosed(a: PracticeAccount, pick: (c: ClosedPractice) => boolean): { ids: string[]; usd: number } {
  const main = a.closed.filter(pick);
  const ids = main.map((c) => c.id);
  const isGone = (c: { id: string }) => ids.some((id) => c.id === id || c.id.startsWith(`${id}-part`));
  const gone = a.closed.filter(isGone);
  const usd = Math.round(gone.reduce((n, c) => n + c.pnlUsd, 0) * 100) / 100;
  a.closed = a.closed.filter((c) => !isGone(c));
  a.balanceUsd = Math.round((a.balanceUsd - usd) * 100) / 100;
  for (const c of main) {
    const key = `${c.strategy ?? 'bot'}:${c.tf ?? (c.ref ? tfOfRef(c.ref) : '')}`;
    const st = a.stats?.[key];
    if (st) a.stats![key] = st.filter(([t]) => t !== c.closedAt);
    const lg = a.ledger?.[key];
    if (lg) a.ledger![key] = lg.filter((r) => !(r[0] === c.closedAt && (!c.ref || r[3] === c.ref)));
  }
  if (a.peakUsd !== undefined) a.peakUsd = usd > 0 ? Math.max(a.balanceUsd, a.peakUsd - usd) : Math.max(a.peakUsd, a.balanceUsd);
  const refs = main.map((c) => c.ref).filter((r): r is string => !!r);
  if (refs.length) a.skipRefs = [...(a.skipRefs ?? []), ...refs].slice(-50); // v27.22: never re-opened
  return { ids: gone.map((c) => c.id), usd };
}

/** v27.71 (owner: "yes revert it … I need it accurate"): closed index trades that paid the old 0.03% a side venue fee get the
 * difference to `newPct` back — balance, the row's P&L and fee, its strategy record and R ledger. Only rows whose stored fee
 * IS the old rate's (2 × oldPct × margin × leverage) are touched, so it can't refund twice. Mutates `a`. Pure. */
export function refundIndexFees(a: PracticeAccount, oldPct: number, newPct: number): { ids: string[]; usd: number; rows: Array<{ id: string; usd: number }> } {
  const ids: string[] = [];
  const rows: Array<{ id: string; usd: number }> = [];
  let total = 0;
  for (const c of a.closed) {
    if (instrument(c.pair)?.kind !== 'index' || !(c.feeUsd && c.feeUsd > 0)) continue;
    const old = (2 * oldPct * c.marginUsd * c.leverage) / 100;
    if (Math.abs(c.feeUsd - old) > Math.max(0.02, old * 0.01)) continue;
    const fee = Math.round(((c.feeUsd * newPct) / oldPct) * 100) / 100;
    const diff = Math.round((c.feeUsd - fee) * 100) / 100;
    if (!(diff > 0)) continue;
    c.feeUsd = fee;
    c.pnlUsd = Math.round((c.pnlUsd + diff) * 100) / 100;
    total += diff;
    ids.push(c.id);
    rows.push({ id: c.id, usd: c.pnlUsd });
    if (c.reason === 'partial') continue;
    const key = `${c.strategy ?? 'bot'}:${c.tf ?? (c.ref ? tfOfRef(c.ref) : '')}`;
    const st = a.stats?.[key];
    if (st) a.stats![key] = st.map(([t, u]) => (t === c.closedAt ? [t, Math.round((u + diff) * 100) / 100] : [t, u]) as [number, number]);
    const lg = a.ledger?.[key];
    if (lg)
      a.ledger![key] = lg.map((r) => {
        if (r[0] !== c.closedAt || (c.ref && r[3] !== c.ref)) return r;
        const usd = Math.round((r[1] + diff) * 100) / 100;
        return [r[0], usd, c.riskUsd0 && c.riskUsd0 > 0 ? Math.round((usd / c.riskUsd0) * 1000) / 1000 : r[2], r[3], r[4]] as LedgerRow;
      });
  }
  const usd = Math.round(total * 100) / 100;
  a.balanceUsd = Math.round((a.balanceUsd + usd) * 100) / 100;
  if (a.peakUsd !== undefined) a.peakUsd = Math.max(a.peakUsd, a.balanceUsd);
  return { ids, usd, rows };
}

/** v27.24: the account's current run of losing bot trades (newest first; manual closes, parts and weekend legs skipped). Pure. */
export function lossStreak(closed: readonly ClosedPractice[]): { n: number; lastAt: number | null } {
  let n = 0;
  let lastAt: number | null = null;
  for (const c of closed) {
    if (c.reason === 'manual' || c.reason === 'partial' || c.reason === 'weekend' || !c.strategy) continue;
    const total = c.pnlUsd + (c.bankedUsd ?? 0);
    if (total >= 0) break;
    n++;
    lastAt ??= c.closedAt;
  }
  return { n, lastAt };
}

/**
 * v27.22 (owner: "take away the trade that's −60, don't make it count"): strike chosen OPEN positions (+ their parts and
 * booked rolls) as if they never happened, and remember their refs so the bot never opens that signal again. Pure.
 */
export function undoPositions(a: PracticeAccount, pick: (p: PracticePosition) => boolean): { ids: string[]; usd: number; refs: string[] } {
  const gone = a.open.filter(pick);
  const ids = gone.map((p) => p.id);
  const partOf = (c: { id: string }) => ids.some((id) => c.id === id || c.id.startsWith(`${id}-part`));
  const usd = Math.round(gone.reduce((n, p) => n + (p.bankedUsd ?? 0), 0) * 100) / 100;
  a.closed = a.closed.filter((c) => !partOf(c));
  a.open = a.open.filter((p) => !pick(p));
  a.balanceUsd = Math.round((a.balanceUsd - usd) * 100) / 100;
  if (a.peakUsd !== undefined && usd > 0) a.peakUsd = Math.max(a.balanceUsd, a.peakUsd - usd);
  const refs = gone.map((p) => p.ref).filter((r): r is string => !!r);
  if (refs.length) a.skipRefs = [...(a.skipRefs ?? []), ...refs].slice(-50);
  return { ids, usd, refs };
}

/**
 * v27.58 (owner: "adjust the current live trade as if it has 20%"): re-size the OPEN Discord copies (tf 'signal') as if
 * they had opened at `pct`% of the balance on their original stop — same entry, more units; all copies together ≤ `pct`;
 * margin ≤ the all-in share of the free margin. The $ loss cap is lifted (`allIn`) and a stop the cap had pulled in goes
 * back to the original distance (a stop the profit lock moved stays). Nothing booked changes. Mutates `a`. Pure.
 */
export function resizeCopies(a: PracticeAccount, pct: number, mids: Record<string, number>): string[] {
  const out: string[] = [];
  const copies = a.open.filter((p) => p.tf === 'signal' && !p.closePending);
  let left = pct;
  for (const p of copies) {
    const per = Math.abs(pnlUsd({ pair: p.pair, side: 1, units: 1, entry: p.entry }, p.entry + 1, { ...mids, [p.pair]: mids[p.pair] ?? p.entry }));
    const nowStopDist = p.stop === null ? 0 : p.side * (p.entry - p.stop);
    const d0 = p.riskUsd0 && p.units > 0 && per > 0 ? p.riskUsd0 / (p.units * per) : nowStopDist;
    if (!(per > 0) || !(d0 > 0)) {
      out.push(`${p.pair} ${p.strategy}: no stop distance to size from — left as is`);
      continue;
    }
    const wantUsd = (a.balanceUsd * Math.max(0, left)) / 100;
    const haveUsd = p.units * per * d0;
    const otherMargin = a.open.filter((x) => x !== p).reduce((n, x) => n + x.marginUsd, 0);
    const freeUsd = Math.max(0, a.balanceUsd - otherMargin);
    let f = wantUsd / haveUsd;
    f = Math.min(f, (freeUsd * BOT.allInMarginShare) / Math.max(p.marginUsd, 1e-9));
    if (!(f > 1.0001)) {
      p.allIn = true;
      delete p.maxLossUsd;
      left -= p.riskPct ?? 0;
      out.push(`${p.pair} ${p.strategy}: already ${p.riskPct ?? '?'}% — no bigger size fits`);
      continue;
    }
    const before = p.units;
    p.units = p.units * f;
    p.marginUsd = Math.round(p.marginUsd * f * 100) / 100;
    p.riskUsd0 = Math.round(haveUsd * f * 100) / 100;
    p.riskPct = a.balanceUsd > 0 ? Math.round((p.riskUsd0 / a.balanceUsd) * 10_000) / 100 : pct;
    p.allIn = true;
    delete p.maxLossUsd;
    // a stop the $ cap pulled in (tighter than the original, still on the losing side, not the profit lock's) goes back
    if (!p.locked && p.stop !== null && nowStopDist > 0 && nowStopDist < d0 * 0.999) {
      p.stop = p.entry - p.side * d0;
      p.stopMovedT = null;
    }
    left -= p.riskPct;
    out.push(`${p.pair} ${p.strategy} ${p.side === 1 ? 'long' : 'short'} re-sized as if opened at ${p.riskPct}%: ${before.toPrecision(4)} → ${p.units.toPrecision(4)} units, $${p.riskUsd0} at the stop ${p.stop?.toPrecision(7)}, margin $${p.marginUsd}`);
  }
  if (!copies.length) out.push('no open Kojiro copy to re-size');
  return out;
}

/**
 * v27.60 (owner: "revert the exit, put it at 20%, continue the trade where it was"): a closed Discord copy is put back as
 * if it had never closed — its close (and parts) struck from the balance / record, the position re-opened with its
 * original entry, opening time and ORIGINAL stop, no profit lock, then re-sized to `pct` (`resizeCopies`). Stop / target
 * checks resume from the minute it closed. Returns the closed ids to drop from the P&L log + lines. Mutates `a`. Pure.
 */
export function reviveCopy(a: PracticeAccount, ref: string, pct: number): { ids: string[]; lines: string[] } {
  const row = a.closed.filter((c) => c.ref === ref && c.reason !== 'partial').sort((x, y) => y.closedAt - x.closedAt)[0];
  if (!row) return { ids: [], lines: [`no closed trade ${ref} to put back`] };
  if (a.open.some((p) => p.ref === ref)) return { ids: [], lines: [`${row.pair} copy is already open`] };
  const { ids, usd } = undoClosed(a, (c) => c.id === row.id);
  a.skipRefs = (a.skipRefs ?? []).filter((r) => r !== ref);
  const { exit: _x, closedAt, pnlUsd: _p, reason: _r, feeUsd: _f, ...pos } = row;
  void _x; void _p; void _r; void _f;
  const per = Math.abs(pnlUsd({ pair: row.pair, side: 1, units: 1, entry: row.entry }, row.entry + 1, { [row.pair]: row.entry }));
  const d0 = row.riskUsd0 && row.units > 0 && per > 0 ? row.riskUsd0 / (row.units * per) : 0;
  // v27.61: lock left unset → the next check works out the (looser) copy lock from the original stop
  const back: PracticePosition = { ...pos, stop: d0 > 0 ? row.entry - row.side * d0 : row.stop, locked: false, lockBest: null, stopMovedT: null, closePending: null, checkedT: closedAt - 60_000 };
  delete back.lock;
  a.open.push(back);
  const lines = [`${row.pair} ${row.side === 1 ? 'long' : 'short'} copy put back as if it never closed (its ${row.reason} close ${usd >= 0 ? '+' : '−'}$${Math.abs(usd).toFixed(2)} struck), entry ${row.entry}, stop ${back.stop?.toPrecision(7)}`, ...resizeCopies(a, pct, {})];
  return { ids, lines };
}

/**
 * v27.65 (owner: "count it in as well in the portfolio"): book a call the copier missed as if it had been copied — the copy's
 * size (`riskPct` of the balance now on the 0.5% safety stop, leverage capped per market, margin ≤ its share of the balance),
 * opened at his price, closed at `exit` (reason 'signal', fee included), into the balance, P&L log, record and R ledger.
 * Refused when that ref is already in the account. Mutates `a`. Pure.
 */
export function bookMissedCopy(a: PracticeAccount, r: { pair: string; side: 1 | -1; entry: number; exit: number; openedAt: number; closedAt: number; ref: string; strategy: string; riskPct: number; leverage: number }): string {
  const inst = instrument(r.pair);
  if (!inst) return `unknown market ${r.pair}`;
  if (a.closed.some((c) => c.ref === r.ref) || a.open.some((p) => p.ref === r.ref)) return `${r.pair} call ${r.ref} is already booked`;
  const mids = { [r.pair]: r.entry };
  const stop = copyStop(r.side, r.entry, null);
  const stopDist = Math.abs(r.entry - stop);
  const perUnit = unitsFor(inst, 1, mids);
  const usdPerUnitMove = Math.abs(pnlUsd({ pair: r.pair, side: 1, units: 1, entry: r.entry }, r.entry + 1, mids));
  const lev = Math.max(1, Math.min(Math.round(r.leverage), MAX_LEVERAGE, maxLeverageFor(inst.id)));
  const size = copySize({ riskUsd: (a.balanceUsd * r.riskPct) / 100, stopDist, usdPerUnitMove, notionalPerUnit: perUnit ? 1 / perUnit : 0, leverage: lev, freeMarginUsd: a.balanceUsd, marginShare: DISCORD_COPY.marginShare });
  if (!(size.marginUsd > 0)) return 'no room to size it';
  const units = unitsFor(inst, size.marginUsd * lev, mids) ?? 0;
  if (!(units > 0)) return 'no price to size it';
  const p: PracticePosition = { id: `copy-${r.ref.split(':').pop()}`, pair: r.pair, side: r.side, units, entry: r.entry, marginUsd: size.marginUsd, leverage: lev, stop, target: null, openedAt: r.openedAt, checkedT: r.closedAt, strategy: r.strategy, ref: r.ref, tf: 'signal', allIn: true, riskPct: r.riskPct, riskUsd0: size.riskUsd };
  a.open.push(p);
  const pl = closePos(a, p, r.exit, mids, 'signal', r.closedAt);
  a.peakUsd = Math.max(a.peakUsd ?? a.balanceUsd, a.balanceUsd);
  return `${r.pair} ${r.side === 1 ? 'long' : 'short'} call booked as if copied: ${units.toFixed(3)} units ${r.entry} → ${r.exit}, ${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(2)} after fees`;
}

/** v27.69: how a trade opened at `entry` would have gone on these minutes (after its entry): the stop first when a
 * candle touches both, the profit lock arming on the best price and moving the stop from the NEXT minute on. Pure. */
export function walkTrade(side: 1 | -1, entry: number, stop0: number, target: number | null, bars: readonly Bar[], half: number, fee = 0, lockFrom = stop0): { exitIdx: number; exit: number; reason: 'stop' | 'target' | null; stop: number; best: number; locked: boolean; lock: LockPlan | null } {
  const lock = lockPlanNet(side, entry, lockFrom, target, half, fee, PROFIT_LOCK);
  let stop = stop0;
  let best = entry;
  let locked = false;
  for (let k = 0; k < bars.length; k++) {
    const b = bars[k]!;
    const adv = side === 1 ? b.l : b.h;
    const fav = side === 1 ? b.h : b.l;
    if (side * (adv - stop) <= 0) return { exitIdx: k, exit: side * (b.o - stop) < 0 ? b.o : stop, reason: 'stop', stop, best, locked, lock };
    if (target !== null && side * (fav - target) >= 0) return { exitIdx: k, exit: target, reason: 'target', stop, best, locked, lock };
    best = side === 1 ? Math.max(best, fav) : Math.min(best, fav);
    if (lock && side * (best - lock.at) >= 0) {
      stop = lockedStop(side, lock, best, stop);
      locked = true;
    }
  }
  return { exitIdx: -1, exit: NaN, reason: null, stop, best, locked, lock };
}

/**
 * v27.78 (owner: "redo those 2 trades with a limit of 50 loss and let it grow properly as if it never closed"): a closed
 * bot trade is struck and replayed from its entry on the 1-minute candles since (`after`) as if it had opened with a
 * `capUsd` loss cap — stop = its tested stop, pulled in only as far as that cap (never tighter); the profit lock measured
 * on the tested stop (as the live check does); `closeAt` (the time the bot would have followed the lab's exit) closes it
 * at that minute's close. Ended → booked at its exit; still running → left open from the last minute on. Pure.
 */
export function replayBotTrade(a: PracticeAccount, ref: string, capUsd: number, after: readonly Bar[], closeAt: number | null = null): { ids: string[]; line: string } {
  const row = a.closed.filter((c) => c.ref === ref && c.reason !== 'partial').sort((x, y) => y.closedAt - x.closedAt)[0];
  if (!row) return { ids: [], line: `no closed trade ${ref} to replay` };
  if (a.open.some((p) => p.ref === ref)) return { ids: [], line: `${row.pair} ${ref} is already open` };
  const inst = instrument(row.pair);
  const per = Math.abs(pnlUsd({ pair: row.pair, side: 1, units: 1, entry: row.entry }, row.entry + 1, { [row.pair]: row.entry }));
  const d0 = row.riskUsd0 && row.units > 0 && per > 0 ? row.riskUsd0 / (row.units * per) : 0;
  if (!inst || !(d0 > 0)) return { ids: [], line: `${row.pair} ${ref}: no tested stop to replay from` };
  const { ids, usd } = undoClosed(a, (c) => c.id === row.id);
  a.skipRefs = (a.skipRefs ?? []).filter((r) => r !== ref);
  const side = row.side;
  const tested = row.entry - side * d0;
  const capStop = row.entry - (side * capUsd) / (row.units * per);
  const stop0 = side * (capStop - tested) > 0 ? capStop : tested;
  const half = (inst.spreadPips * inst.pip) / 2;
  const fee = feePxOf(inst, row.entry);
  const start = Math.floor(row.openedAt / 60_000) * 60_000 + 60_000;
  let bars = after.filter((b) => b.t >= start);
  let cut: number | null = null;
  if (closeAt !== null) {
    const k = bars.findIndex((b) => b.t >= closeAt);
    if (k >= 0) { cut = k; bars = bars.slice(0, k + 1); }
  }
  const w = walkTrade(side, row.entry, stop0, row.target, bars, half, fee, tested);
  const { exit: _x, closedAt: _c, pnlUsd: _p, reason: _r, feeUsd: _f, ...pos } = row;
  void _x; void _c; void _p; void _r; void _f;
  const p: PracticePosition = { ...pos, stop: w.stop, maxLossUsd: capUsd, lock: w.lock, locked: w.locked, lockBest: w.locked ? w.best : null, stopMovedT: null, closePending: null, checkedT: bars.length ? bars[bars.length - 1]!.t : row.openedAt };
  a.open.push(p);
  const was = `${usd >= 0 ? '+' : '−'}$${Math.abs(usd).toFixed(2)}`;
  const what = `${row.pair} ${side === 1 ? 'long' : 'short'} (${row.strategy ?? 'bot'} ${row.tf ?? ''}) replayed with a $${capUsd} cap — entry ${row.entry}, stop ${stop0.toPrecision(6)} (tested ${tested.toPrecision(6)}); its ${was} close struck`;
  const endIdx = w.exitIdx >= 0 ? w.exitIdx : cut;
  if (endIdx === null) return { ids, line: `${what} — still running, stop now ${w.stop.toPrecision(6)}` };
  const b = bars[endIdx]!;
  const px = w.exitIdx >= 0 ? w.exit : b.c - side * half;
  const reason: ClosedPractice['reason'] = w.exitIdx >= 0 ? (w.reason ?? 'stop') : 'signal';
  const at = b.t + 60_000;
  const pl = closePos(a, p, px, { [row.pair]: px }, reason, at);
  a.peakUsd = Math.max(a.peakUsd ?? a.balanceUsd, a.balanceUsd);
  const how = w.exitIdx < 0 ? 'the lab closed its trade' : w.reason === 'target' ? 'target' : w.locked ? 'profit-lock stop' : 'stop';
  return { ids, line: `${what} — closed at ${px.toPrecision(6)} (${how}) at ${new Date(at).toISOString().slice(11, 16)} UTC: ${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(2)}` };
}

/** v27.69 (owner: "it legit had levels but the bot didn't take em — go in them at the exact time"): book a level trade
 * the bot missed as if it had taken it at `openedAt` / `entry` (sized like his level trades: `riskPct` on its stop, ≤ the
 * copy margin share); the minutes since decide whether it is already closed (stop / target / locked stop) or still
 * running (then it stays open from the last minute on, the normal checks take over). Mutates `a`. */
export function bookLevelTrade(a: PracticeAccount, r: { pair: string; side: 1 | -1; entry: number; stop: number; target: number | null; openedAt: number; ref: string; strategy: string; riskPct: number; leverage: number }, after: readonly Bar[]): { line: string; closedAt: number | null } {
  const inst = instrument(r.pair);
  if (!inst) return { line: `unknown market ${r.pair}`, closedAt: null };
  if (a.closed.some((c) => c.ref === r.ref) || a.open.some((p) => p.ref === r.ref)) return { line: `${r.pair} level trade ${r.ref} is already booked`, closedAt: null };
  const mids = { [r.pair]: r.entry };
  const stopDist = Math.abs(r.entry - r.stop);
  if (!(stopDist > 0) || r.side * (r.entry - r.stop) <= 0) return { line: `${r.pair}: stop on the wrong side`, closedAt: null };
  const perUnit = unitsFor(inst, 1, mids);
  const usdPerUnitMove = Math.abs(pnlUsd({ pair: r.pair, side: 1, units: 1, entry: r.entry }, r.entry + 1, mids));
  const lev = Math.max(1, Math.min(Math.round(r.leverage), MAX_LEVERAGE, maxLeverageFor(inst.id)));
  const size = copySize({ riskUsd: (a.balanceUsd * r.riskPct) / 100, stopDist, usdPerUnitMove, notionalPerUnit: perUnit ? 1 / perUnit : 0, leverage: lev, freeMarginUsd: a.balanceUsd, marginShare: DISCORD_COPY.marginShare });
  if (!(size.marginUsd > 0)) return { line: 'no room to size it', closedAt: null };
  const units = unitsFor(inst, size.marginUsd * lev, mids) ?? 0;
  if (!(units > 0)) return { line: 'no price to size it', closedAt: null };
  const bars = after.filter((b) => b.t >= r.openedAt);
  const w = walkTrade(r.side, r.entry, r.stop, r.target, bars, (inst.spreadPips * inst.pip) / 2, feePxOf(inst, r.entry));
  const p: PracticePosition = { id: `lvl-${r.ref.split(':').pop()}`, pair: r.pair, side: r.side, units, entry: r.entry, marginUsd: size.marginUsd, leverage: lev, stop: w.stop, target: r.target, openedAt: r.openedAt, checkedT: bars.length ? bars[bars.length - 1]!.t + 60_000 : r.openedAt, strategy: r.strategy, ref: r.ref, tf: 'signal', allIn: true, riskPct: r.riskPct, riskUsd0: size.riskUsd, lock: w.lock, locked: w.locked, lockBest: w.locked ? w.best : null };
  a.open.push(p);
  const what = `${r.pair} ${r.side === 1 ? 'long' : 'short'} at his level booked as if taken at ${new Date(r.openedAt).toISOString().slice(11, 16)} UTC: ${units.toFixed(3)} units at ${r.entry}, stop ${+r.stop.toFixed(2)}${r.target !== null ? `, target ${r.target}` : ''}`;
  if (w.exitIdx < 0) return { line: `${what} — still running (stop now ${+w.stop.toFixed(2)})`, closedAt: null };
  const at = bars[w.exitIdx]!.t + 60_000;
  const pl = closePos(a, p, w.exit, { [r.pair]: w.exit }, w.reason ?? 'stop', at);
  a.peakUsd = Math.max(a.peakUsd ?? a.balanceUsd, a.balanceUsd);
  return { line: `${what} — closed at ${+w.exit.toFixed(2)} (${w.reason === 'target' ? 'target' : w.locked ? 'locked-in stop' : 'stop'}) at ${new Date(at).toISOString().slice(11, 16)} UTC, ${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(2)} after fees`, closedAt: at };
}

/**
 * v20.1 (owner: "revert all current active trades"): strike every OPEN trade from an account as if it never happened —
 * the positions, their parts already taken (USD back out of the balance), their overnight rolls, resting orders and
 * weekend pauses. Closed trades stay. Returns what was removed + the ids whose P&L-log rows must go. Mutates `a`. Pure.
 */
export function undoOpen(a: PracticeAccount): { open: number; parts: number; usd: number; orders: number; paused: number; ids: string[] } {
  const ids = a.open.map((p) => p.id);
  const partOf = (c: { id: string }) => ids.some((id) => c.id === id || c.id.startsWith(`${id}-part`));
  const parts = a.closed.filter(partOf);
  // every dollar these trades booked so far: parts taken + rolls (bankedUsd), never the unrealised P&L (never booked)
  const usd = Math.round(a.open.reduce((n, p) => n + (p.bankedUsd ?? 0), 0) * 100) / 100;
  a.closed = a.closed.filter((c) => !partOf(c));
  a.balanceUsd = Math.round((a.balanceUsd - usd) * 100) / 100;
  const open = a.open.length;
  a.open = [];
  const orders = (a.orders ?? []).length;
  if (a.orders) a.orders = [];
  const paused = (a.resume ?? []).length;
  if (a.resume) a.resume = [];
  if (a.peakUsd !== undefined && usd > 0) a.peakUsd = Math.max(a.balanceUsd, a.peakUsd - usd);
  return { open, parts: parts.length, usd, orders, paused, ids };
}

/** v27.67: sell into a big spike (see the call in `tick`). Bot trades only (they carry a lab ref — never the owner's own
 * trades, never a Kojiro copy: those follow his exit). */
export const SPIKE_EXIT = {
  on: true,
  /** the move its way within `windowMs` (from the worst price of that window to now), in R */
  jumpR: 0.3,
  windowMs: 5 * 60_000,
  /** and the trade is at least this far in profit now (R), and at least `minUsd` after the close fee */
  minR: 0.3,
  minUsd: 5,
};

/** The reason to sell into a spike now, or null. Pure. */
export function spikeExitFor(p: PracticePosition, q: Pick<Quote, 'mid' | 'bars'>, mids: Record<string, number>, half: number, now: number): string | null {
  if (!SPIKE_EXIT.on || !p.ref || p.tf === 'signal' || !(p.riskUsd0 && p.riskUsd0 > 0) || !(p.units > 0)) return null;
  const per = Math.abs(pnlUsd({ pair: p.pair, side: 1, units: 1, entry: p.entry }, p.entry + 1, mids));
  const d0 = per > 0 ? p.riskUsd0 / (p.units * per) : 0;
  if (!(d0 > 0)) return null;
  const recent = q.bars.filter((b) => b[0] >= now - SPIKE_EXIT.windowMs && b[0] >= p.openedAt - 60_000);
  if (!recent.length) return null;
  const worst = p.side === 1 ? Math.min(...recent.map((b) => b[2])) : Math.max(...recent.map((b) => b[1]));
  const jump = (p.side * (q.mid - worst)) / d0;
  const px = exitPx(p, q.mid, half);
  const inR = (p.side * (px - p.entry)) / d0;
  if (jump < SPIKE_EXIT.jumpR || inR < SPIKE_EXIT.minR) return null;
  const fee = feeUsd(instrument(p.pair) ?? { id: p.pair, kind: 'fx' }, p.marginUsd, p.leverage);
  if (pnlUsd(p, px, mids) - fee < SPIKE_EXIT.minUsd) return null;
  return `+${jump.toFixed(2)}R in ${Math.round(SPIKE_EXIT.windowMs / 60_000)} min, now +${inR.toFixed(2)}R`;
}

/** Close a position; a bot trade's total (parts + this close) goes into its record unless it only paused for the
 * weekend. Returns this close's P&L. Mutates `a`. */
function closePos(a: PracticeAccount, p: PracticePosition, px: number, mids: Record<string, number>, reason: ClosedPractice['reason'], at: number): number {
  ensureStats(a); // an older account's record is rebuilt from the closed list BEFORE this close joins it
  // v26: the venue's open + close fee on what is left of the position (venue-fees.ts)
  const fee = feeUsd(instrument(p.pair) ?? { id: p.pair, kind: 'fx' }, p.marginUsd, p.leverage);
  const pl = Math.round((pnlUsd(p, px, mids) - fee) * 100) / 100;
  a.balanceUsd = Math.round((a.balanceUsd + pl) * 100) / 100;
  a.open = a.open.filter((x) => x.id !== p.id);
  a.closed.unshift({ ...p, exit: px, closedAt: at, pnlUsd: pl, reason, ...(fee > 0 ? { feeUsd: fee } : {}) });
  a.closed = a.closed.slice(0, 200);
  logClose(a, a.closed[0]!); // v17.8
  // v17.12: a phone alert for a finished trade (a weekend pause is not the end of it)
  if (reason !== 'weekend' && reason !== 'partial') notice(a, { kind: 'close', pair: p.pair, side: p.side, pnlUsd: Math.round((pl + (p.bankedUsd ?? 0)) * 100) / 100, reason, strategy: p.strategy ?? null });
  if (reason !== 'weekend' && reason !== 'partial') recordTrade(a, statKey(p), at, pl + (p.bankedUsd ?? 0), { ...(p.ref ? { ref: p.ref } : {}), ...(p.riskUsd0 ? { riskUsd0: p.riskUsd0 } : {}), why: reason });
  return pl;
}

/** v27.46: a lab trade pauses over the weekend and comes back Monday; a Discord copy (tf 'signal') just ends there */
const pausable = (p: PracticePosition) => !!p.ref && p.tf !== 'signal';
const copyRec = (p: PracticePosition) => (p.ref ? { ref: p.ref, ...(p.riskUsd0 ? { riskUsd0: p.riskUsd0 } : {}), why: 'weekend' as const } : undefined);

/** v17: the weekend pause of a bot trade (re-opened after Monday's open while the lab still holds it). Pure. */
function resumeItemOf(p: PracticePosition, leg: number, at: number): ResumeItem {
  return { ref: p.ref!, ...(p.strategy ? { strategy: p.strategy } : {}), pair: p.pair, side: p.side, ...(p.riskPct !== undefined ? { riskPct: p.riskPct } : {}), scaled: !!p.scaled, tpHit: !!p.tpHit, lev: p.leverage, bankedUsd: Math.round(((p.bankedUsd ?? 0) + leg) * 100) / 100, ...(p.riskUsd0 ? { riskUsd0: p.riskUsd0 } : {}), at };
}

/** Close part of a position (a scale-out): realise its P&L, keep the rest open. Mutates `a`. */
function closePart(a: PracticeAccount, p: PracticePosition, frac: number, px: number, mids: Record<string, number>, at: number): number {
  const units = p.units * frac;
  const part = { ...p, units, marginUsd: Math.round(p.marginUsd * frac * 100) / 100 };
  const fee = feeUsd(instrument(p.pair) ?? { id: p.pair, kind: 'fx' }, p.marginUsd * frac, p.leverage); // v26
  const pl = Math.round((pnlUsd(part, px, mids) - fee) * 100) / 100;
  a.balanceUsd = Math.round((a.balanceUsd + pl) * 100) / 100;
  p.bankedUsd = Math.round(((p.bankedUsd ?? 0) + pl) * 100) / 100;
  p.units -= units;
  p.marginUsd = Math.round(p.marginUsd * (1 - frac) * 100) / 100;
  // one id per part (a trade can take part off at +1R and again at its target)
  const n = a.closed.filter((c) => c.id.startsWith(`${p.id}-part`)).length;
  a.closed.unshift({ ...part, id: `${p.id}-part${n ? n + 1 : ''}`, exit: px, closedAt: at, pnlUsd: pl, reason: 'partial', ...(fee > 0 ? { feeUsd: fee } : {}) });
  a.closed = a.closed.slice(0, 200);
  logClose(a, a.closed[0]!); // v17.8
  return pl;
}

/** v18.4: turn a resting order into a position at `fill` (the position looks exactly like one `openIn` makes). Returns an
 * error when it can't (a gap through the stop, no margin left). Mutates `a`. */
export function fillOrder(a: PracticeAccount, o: RestingOrder, fill: number, mids: Record<string, number>, now: number, checkedT: number): string | null {
  const inst = instrument(o.pair);
  if (!inst) return 'unknown market';
  if (o.side === 1 ? o.stop >= fill : o.stop <= fill) return 'the price gapped past its stop';
  if (o.target !== null && (o.side === 1 ? o.target <= fill : o.target >= fill)) return 'the price gapped past its target';
  const v = view(a, mids);
  if (o.marginUsd > v.freeMarginUsd) return `not enough free margin ($${v.freeMarginUsd})`;
  const units = unitsFor(inst, o.marginUsd * o.leverage, mids);
  if (!units) return 'no conversion price';
  const riskUsd0 = Math.round(positionRiskUsd({ pair: inst.id, side: o.side, units, entry: fill, stop: o.stop }, mids) * 100) / 100;
  a.open.push({
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    pair: inst.id,
    side: o.side,
    units,
    entry: fill,
    marginUsd: Math.round(o.marginUsd * 100) / 100,
    leverage: o.leverage,
    stop: o.stop,
    target: o.target,
    openedAt: now,
    checkedT,
    strategy: o.strategy,
    ref: o.ref,
    riskPct: o.riskPct,
    ...(o.conviction ? { conviction: o.conviction } : {}),
    ...(o.sniper ? { sniper: o.sniper } : {}),
    ...(o.beAt != null ? { beAt: o.beAt } : {}),
    ...(o.scaleAt != null ? { scaleAt: o.scaleAt, scaleFrac: o.scaleFrac ?? 0.5, scaled: !!o.scaled } : {}),
    ...(o.tpTrailPx != null ? { tpTrailPx: o.tpTrailPx, tpFrac: o.tpFrac ?? 0, tpHit: !!o.tpHit } : {}),
    ...(o.tf ? { tf: o.tf } : {}),
    ...(o.trailPx != null ? { trailPx: o.trailPx } : {}),
    ...(o.trailAtr != null ? { trailAtr: o.trailAtr } : {}),
    ...(o.maxBars != null ? { maxBars: o.maxBars } : {}),
    ...(o.exitWhen ? { exitWhen: o.exitWhen } : {}),
    ...(riskUsd0 > 0 ? { riskUsd0 } : {}),
  });
  return null;
}

/**
 * Check stops / targets on the new 1-minute bars, then the stop-out. Mutates `a`. Pure apart from that. `mv.moved` is
 * set when a stop moved without an event (the profit lock trailing) — the caller saves the account then too.
 */
export function tick(a: PracticeAccount, quotes: Record<string, Quote>, now: number, mv?: { moved: boolean }, carryFor?: (pair: string, t: number) => number, tightNow?: (pair: string, t: number) => string | null): string[] {
  const mids: Record<string, number> = {};
  const halves: Record<string, number> = {};
  for (const q of Object.values(quotes)) {
    mids[q.id] = q.mid;
    halves[q.id] = (q.ask - q.bid) / 2;
  }
  const events: string[] = [];
  for (const p of [...a.open]) {
    const q = quotes[p.pair];
    if (!q) continue;
    // v17: a close asked for while there was no price happens at the first real one
    if (p.closePending && !q.stale) {
      const leg = closePos(a, p, p.side === 1 ? q.bid : q.ask, mids, p.closePending.reason, now);
      // a weekend close is a pause like the normal flatten: the lab trade comes back after Monday's open
      if (p.closePending.reason === 'weekend') {
        if (pausable(p)) a.resume = [...(a.resume ?? []), resumeItemOf(p, leg, now)];
        else recordTrade(a, statKey(p), now, leg + (p.bankedUsd ?? 0), copyRec(p));
      }
      events.push(`${p.pair} closed at the first price after its exit (${p.closePending.reason})`);
      continue;
    }
    const inst = instrument(p.pair)!;
    const half = halves[p.pair] ?? (inst.spreadPips * inst.pip) / 2;
    // v17.11 the owner's profit lock, worked out once per position from its entry, target (else its stop) and costs
    if (p.lock === undefined) {
      // v27.61: Kojiro's calls (no target) get the looser copy lock — wide early, tight once well in profit
      const copy = p.tf === 'signal' && p.target === null;
      const cfg = copy && p.copyLock !== 'tight' ? COPY_LOCK : PROFIT_LOCK;
      p.lock = a.profitLock !== false && cfg.on ? lockPlanNet(p.side, p.entry, p.stop, p.target, half, feePxOf(inst, p.entry), cfg) : null;
      if (mv) mv.moved = true;
    }
    // v27.66 (owner: "a tight trailing SL in moments of need"): big news for a Kojiro copy's market within 20 minutes →
    // its trailing stop switches to the tight one (only ever tighter; measured from its original stop)
    if (p.tf === 'signal' && p.target === null && p.lock && p.copyLock !== 'tight' && tightNow) {
      const why = tightNow(p.pair, now);
      if (why) {
        const per = Math.abs(pnlUsd({ pair: p.pair, side: 1, units: 1, entry: p.entry }, p.entry + 1, mids));
        const d0 = p.riskUsd0 && p.units > 0 && per > 0 ? p.riskUsd0 / (p.units * per) : p.stop !== null ? Math.abs(p.entry - p.stop) : 0;
        const plan = d0 > 0 ? lockPlanNet(p.side, p.entry, p.entry - p.side * d0, null, half, feePxOf(inst, p.entry), PROFIT_LOCK) : null;
        if (plan) {
          p.lock = plan;
          p.copyLock = 'tight';
          p.tightWhy = why;
          events.push(`${p.pair} Kojiro copy: tight trailing stop now — ${why}`);
          if (mv) mv.moved = true;
        }
      }
    }
    // v18: overnight financing at every daily roll (17:00 New York, Wednesday ×3) since the last one booked — the
    // carry its way minus the broker markup, at the current price; booked into the balance and the trade's total.
    // An unknown rate (feed down) leaves the rolls owed until it is known again.
    if (carryFor && FINANCING.on) {
      const rolls = rollsBetween(p.swapT ?? p.openedAt, now);
      if (rolls.length) {
        const carry = carryFor(p.pair, now);
        if (Number.isFinite(carry)) {
          let usd = 0;
          for (const r of rolls) {
            const gain = swapGain(p.side, carry, q.mid, r.days);
            usd += pnlUsd({ pair: p.pair, side: p.side, units: p.units, entry: q.mid }, q.mid + p.side * gain, mids);
          }
          p.swapT = rolls[rolls.length - 1]!.t;
          const sw = Math.round(usd * 100) / 100;
          if (sw !== 0) {
            p.swapUsd = Math.round(((p.swapUsd ?? 0) + sw) * 100) / 100;
            p.bankedUsd = Math.round(((p.bankedUsd ?? 0) + sw) * 100) / 100;
            a.balanceUsd = Math.round((a.balanceUsd + sw) * 100) / 100;
            events.push(`${p.pair} financing ${sw > 0 ? '+' : '−'}$${Math.abs(sw).toFixed(2)} (${rolls.reduce((n, r) => n + r.days, 0)} ${rolls.length === 1 && rolls[0]!.days === 1 ? 'night' : 'nights'})`);
          } else if (mv) mv.moved = true;
        }
      }
    }
    // v27.67 (owner: "the bot is too focused on the tight TP, I close it way earlier — if there is a big spike, sell"):
    // a bot trade that jumped its way by SPIKE_EXIT.jumpR within the last few minutes and now sits ≥ minR in profit is
    // closed at the market (reason 'spike'). R = its tested stop distance (riskUsd0). Live rule, not lab-graded; his 19
    // hand closes were cut at +0.2…+1.2R (median ≈ +0.3R), 17 of them in profit.
    const spikeWhy = !q.stale && spikeExitFor(p, q, mids, half, now);
    if (spikeWhy) {
      const px = exitPx(p, q.mid, half);
      const pl = closePos(a, p, px, mids, 'spike', now);
      events.push(`${p.pair} big spike its way (${spikeWhy}) — sold into it: ${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(2)}`);
      continue;
    }
    // v27.20: the account's loss cap in USD — the stop is pulled in so this trade can't lose more (never loosened);
    // already past it → closed at the market now
    const capUsd = p.maxLossUsd ?? a.maxLossUsd; // v27.45: the trade's own cap first
    if (capUsd && capUsd > 0 && !q.stale && !p.allIn) {
      const per = pnlUsd({ pair: p.pair, side: p.side, units: p.units, entry: p.entry }, p.entry + p.side, mids);
      if (per > 0) {
        const capStop = p.entry - (p.side * capUsd) / per;
        if (p.stop === null || (p.side === 1 ? capStop > p.stop : capStop < p.stop)) {
          const exitNow = p.side === 1 ? q.bid : q.ask;
          if (p.side === 1 ? exitNow <= capStop : exitNow >= capStop) {
            closePos(a, p, exitNow, mids, 'stop', now);
            events.push(`${p.pair} closed: it reached the $${capUsd} loss cap`);
            continue;
          }
          p.stop = capStop;
          const lastT = q.bars.length ? q.bars[q.bars.length - 1]![0] : now;
          p.stopMovedT = lastT;
          if (mv) mv.moved = true;
          events.push(`${p.pair} stop pulled in to the $${capUsd} loss cap (${capStop.toPrecision(6)})`);
        }
      }
    }
    for (const [t, h, l, cl, o] of q.bars) {
      if (t <= p.checkedT || t < p.openedAt - 60_000) continue;
      // exit side of the book: a long sells at the bid (mid − half), a short buys at the ask (mid + half). In the minute
      // the stop was last moved in, only its close counts against the new stop (its low / high may have come before)
      const exitClose0 = cl - p.side * half;
      const worst = t === p.stopMovedT ? exitClose0 : p.side === 1 ? l - half : h + half;
      const best = p.side === 1 ? h - half : l + half;
      // v17: a minute that OPENS past the level fills at that open (a gap), not at the level
      const openX = o !== undefined && Number.isFinite(o) ? o - p.side * half : null;
      if (p.stop !== null && (p.side === 1 ? worst <= p.stop : worst >= p.stop)) {
        const gapped = openX !== null && (p.side === 1 ? openX < p.stop : openX > p.stop);
        closePos(a, p, gapped ? openX : p.stop, mids, 'stop', now);
        events.push(`${p.pair} stop hit${gapped ? ' (the price gapped past it: filled at the open)' : ''}`);
        break;
      }
      if (p.target !== null && (p.side === 1 ? best >= p.target : best <= p.target)) {
        if (p.tpTrailPx != null && !p.tpHit) {
          // v15 trailing take-profit: not the end — part off (if any), stop locked behind the target, keep riding
          const tgt = p.target;
          const frac = Math.min(0.9, Math.max(0, p.tpFrac ?? 0));
          if (frac > 0) closePart(a, p, frac, tgt, mids, now);
          const lock = tgt - p.side * p.tpTrailPx;
          const ns = p.side === 1 ? Math.max(lock, p.entry) : Math.min(lock, p.entry);
          if (p.stop === null || (p.side === 1 ? ns > p.stop : ns < p.stop)) p.stop = ns;
          p.tpHit = true;
          p.be = true;
          p.target = null;
          events.push(`${p.pair} reached its target${frac > 0 ? `: took ${Math.round(frac * 100)}% off` : ''}, stop locked at ${p.stop.toPrecision(6)}, now trailing`);
          // the rest of this minute: only its close is left to judge
          const exitClose = cl - p.side * half;
          if (p.side === 1 ? exitClose <= p.stop : exitClose >= p.stop) {
            closePos(a, p, p.stop, mids, 'stop', now);
            events.push(`${p.pair} trailing stop hit`);
            break;
          }
          p.checkedT = t;
          continue;
        }
        const gappedT = openX !== null && (p.side === 1 ? openX > p.target : openX < p.target);
        closePos(a, p, gappedT ? openX : p.target, mids, 'target', now);
        events.push(`${p.pair} target hit${gappedT ? ' (gapped past it: filled at the open)' : ''}`);
        break;
      }
      // v14: take part off at +1R / move the stop to break-even (the lab trade's rules)
      let toBe = false;
      if (!p.scaled && p.scaleAt != null && (p.side === 1 ? best >= p.scaleAt : best <= p.scaleAt)) {
        const frac = Math.min(0.9, Math.max(0.1, p.scaleFrac ?? 0.5));
        closePart(a, p, frac, p.scaleAt, mids, now);
        p.scaled = true;
        toBe = true;
        events.push(`${p.pair} took ${Math.round(frac * 100)}% off at +1R`);
      }
      if (!p.be && p.beAt != null && (p.side === 1 ? best >= p.beAt : best <= p.beAt)) toBe = true;
      if (toBe && !p.be) {
        if (p.stop === null || (p.side === 1 ? p.entry > p.stop : p.entry < p.stop)) p.stop = p.entry;
        p.be = true;
      }
      // v17.11 the owner's profit lock: ⅓ of the way to the target → the stop goes past the entry, then it trails ⅓ of
      // the target distance behind the best price, every check (live prices, about every second)
      if (p.lock) {
        const arming = !p.locked && (p.side === 1 ? best >= p.lock.at : best <= p.lock.at);
        if (arming) {
          p.locked = true;
          p.be = true;
          events.push(`${p.pair} profit lock: in profit, stop moved past the entry (tight trail from here)`);
        }
        if (p.locked) {
          p.lockBest = p.lockBest == null ? best : p.side === 1 ? Math.max(p.lockBest, best) : Math.min(p.lockBest, best);
          const ns = lockedStop(p.side, p.lock, p.lockBest, p.stop);
          if (ns !== p.stop) {
            p.stop = ns;
            p.stopMovedT = t;
            if (mv) mv.moved = true;
          }
          if (arming && !((p.alerts ?? 0) & 1)) {
            p.alerts = (p.alerts ?? 0) | 1;
            notice(a, { kind: 'lock', pair: p.pair, side: p.side, pnlUsd: Math.round(pnlUsd(p, exitClose0, mids) * 100) / 100, stopPnlUsd: Math.round(pnlUsd(p, p.stop, mids) * 100) / 100, strategy: p.strategy ?? null });
          }
          // the rest of this minute: only its close is left to judge
          if (p.side === 1 ? exitClose0 <= p.stop : exitClose0 >= p.stop) {
            closePos(a, p, p.stop, mids, 'stop', now);
            events.push(`${p.pair} locked-profit stop hit`);
            break;
          }
        }
      }
      // v17.12: "doing really well" — two thirds of the way to its target (one phone alert)
      if (p.target !== null && !((p.alerts ?? 0) & 2) && p.side * (best - p.entry) >= (2 / 3) * p.side * (p.target - p.entry) && p.side * (p.target - p.entry) > 0) {
        p.alerts = (p.alerts ?? 0) | 2;
        if (mv) mv.moved = true;
        notice(a, { kind: 'run', pair: p.pair, side: p.side, pnlUsd: Math.round(pnlUsd(p, exitClose0, mids) * 100) / 100, stopPnlUsd: p.stop !== null ? Math.round(pnlUsd(p, p.stop, mids) * 100) / 100 : null, strategy: p.strategy ?? null });
      }
      // v17: the minute still forming is checked again next time (its high / low can still grow)
      if (t + 60_000 <= now) p.checkedT = t;
    }
  }
  // v18.4 resting limit orders: filled on the 1-minute candles like the backtester, expired ones dropped
  if (a.orders?.length) {
    const keep: RestingOrder[] = [];
    for (const o of a.orders) {
      if (now > o.expiresAt) {
        events.push(`${o.pair} (${o.strategy}): its limit order expired unfilled`);
        continue;
      }
      const q = quotes[o.pair];
      if (!q || q.stale) {
        keep.push(o);
        continue;
      }
      const inst = instrument(o.pair)!;
      const half = halves[o.pair] ?? (inst.spreadPips * inst.pip) / 2;
      let fill: number | null = null;
      for (const [t, h, l, , op] of q.bars) {
        if (t < o.placedAt - 60_000) continue;
        // a buy limit sits on the ask (mid + half), a sell limit on the bid (mid − half)
        const touched = o.side === 1 ? l + half <= o.limit : h - half >= o.limit;
        if (!touched) continue;
        const openX = op !== undefined && Number.isFinite(op) ? op + o.side * half : null;
        fill = openX !== null && (o.side === 1 ? openX < o.limit : openX > o.limit) ? openX : o.limit;
        break;
      }
      if (fill === null) {
        keep.push(o);
        continue;
      }
      const err = fillOrder(a, o, fill, mids, now, q.bars[q.bars.length - 1]?.[0] ?? now);
      events.push(err ? `${o.pair} (${o.strategy}): limit order not filled — ${err}` : `filled ${o.side === 1 ? 'long' : 'short'} ${o.pair} (${o.strategy}) on its ${o.kind === 'pullback' ? 'pullback' : 'limit'} order at ${fill.toPrecision(6)}`);
    }
    a.orders = keep;
  }
  const v = view(a, mids, halves);
  // v17: never a margin call on made-up prices — every open market needs a quote this tick
  if (v.marginLevelPct !== null && v.marginLevelPct <= STOP_OUT_PCT && a.open.every((p) => mids[p.pair] !== undefined)) {
    for (const p of [...a.open]) closePos(a, p, exitPx(p, mids[p.pair] ?? p.entry, halves[p.pair]), mids, 'stop-out', now);
    events.push('margin call: every position closed');
  }
  if (a.balanceUsd < 0) a.balanceUsd = 0;
  return events;
}

// ── live side ──

/** Half the typical retail spread of a market at time t (v16: the measured hour-of-day profile, wider at rollover). Pure. */
export const syntheticHalf = (inst: Pick<Instrument, 'id' | 'spreadPips' | 'pip'>, t: number) => (inst.spreadPips * inst.pip * spreadMultAt(inst.id, t, null)) / 2;

async function fetchQuote(inst: Instrument): Promise<Quote | null> {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(inst.yahoo)}?interval=1m&range=1d`;
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const j = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number; chartPreviousClose?: number; exchangeDataDelayedBy?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> } }> } };
      const r = j.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0];
      const bars: Quote['bars'] = [];
      (r?.timestamp ?? []).forEach((ts, k) => {
        const h = q?.high?.[k];
        const l = q?.low?.[k];
        const c = q?.close?.[k];
        const o = q?.open?.[k];
        if (h != null && l != null && c != null && c > 0) bars.push(o != null && o > 0 ? [ts * 1000, h, l, c, o] : [ts * 1000, h, l, c]);
      });
      const mid = r?.meta?.regularMarketPrice ?? bars[bars.length - 1]?.[3];
      if (!mid || !(mid > 0)) continue;
      // v16: the synthetic spread follows the measured hour-of-day profile (wider at rollover)
      const half = syntheticHalf(inst, Date.now());
      const prev = r?.meta?.chartPreviousClose;
      const mt = r?.meta?.regularMarketTime;
      const priceT = mt && mt > 0 ? mt * 1000 : bars[bars.length - 1]?.[0];
      const delay = r?.meta?.exchangeDataDelayedBy;
      return { id: inst.id, mid, bid: mid - half, ask: mid + half, t: Date.now(), bars: bars.slice(-180), dayChangePct: prev ? Math.round(((mid / prev - 1) * 100) * 100) / 100 : null, source: 'yahoo', ...(prev ? { prevClose: prev } : {}), ...(priceT ? { priceT } : {}), ...(delay && delay > 0 ? { delayMs: delay * 60_000 } : {}) };
    } catch {
      // next host
    }
  }
  return null;
}

/** v17: the correlated-risk cap as the bot uses it live (the latest correlations; `active` once the honest test proved it). */
export interface HeatLive {
  active: boolean;
  book: Pick<CorrBook, 'idx'>;
  m: Float32Array | null;
}

/** A lab paper trade as the bot sees it (v14: + the judge's score and the trade's exit rules). */
export interface LabOpenTrade {
  /** v27.27: risk this % of the account on the tested stop (a proven strategy while only proven ones trade) */
  allIn?: number;
  ref: string;
  strategy: string;
  tf?: string;
  pair: string;
  side: 1 | -1;
  entryT: number;
  /** v17: the lab's fill (the bot doesn't chase a price that ran far from it) */
  entry?: number;
  /** v17: a check it was tested with has no data right now (feed down) — the trade waits */
  dataWait?: string | null;
  /** v25: a Fibonacci-style signal with no second setup beside it — the trade waits */
  soloWait?: string | null;
  stop: number;
  target: number | null;
  chosen: boolean;
  sizeF?: number;
  /** v20: a market desk's learning trade (half size, market entry, judge / conviction skipped) */
  desk?: { rank: number; of: number; why: string } | null;
  prio?: number;
  /** the signal judge: win probability, whether it passes, the bar it needs (null = no judge view) */
  judge?: { p: number; ok: boolean; need: number | null; /** v17: what it relies on that is missing right now (the trade waits) */ missing?: string } | null;
  /** v15.2: how sure the bot is (confirmations out of `of`) and the size multiple + leverage that earns (proven tiers only) */
  conviction?: Conviction | null;
  /** v16: the sniper's vote count, the level it needs, whether this trade gets the sniper size, and the votes in words */
  sniper?: SniperTag | null;
  beAt?: number | null;
  scaleAt?: number | null;
  scaleFrac?: number | null;
  scaled?: boolean;
  /** v15: trailing take-profit (lock distance behind the target, share taken there, whether the target was reached) */
  tpTrailPx?: number | null;
  tpFrac?: number | null;
  tpHit?: boolean;
  /** v15: exit rules still in force (for the trade's plan) */
  trailPx?: number | null;
  trailAtr?: number | null;
  maxBars?: number | null;
  exitWhen?: string | null;
  /** v18.4: the strategy's tested way in is a resting order — the limit (mid price) and when it expires */
  order?: { kind: 'limit' | 'pullback'; limit: number; until: number } | null;
  /** v20.1: market checks on the trade's side at its signal close (strength gap, 4h trend, daily trend, mood), out of
   * `of`; the bot waits while `n < need` (strict mode) */
  agree?: { n: number; of: number; need: number } | null;
  /** v20.4: the strategy's own tested record on this market (`ok` = enough trades, winning); the bot waits while not ok */
  marketRec?: { n: number; pf: number | null; totalR: number; ok: boolean } | null;
}

/** v18.4: a resting limit order on the bot account (entries.ts, picked on the first 70%); filled by `tick` against the
 * 1-minute candles like the backtester (at the limit, or at the minute's open when it gapped past), cancelled when it
 * expires, when the lab's trade ends, or at the weekend flatten. */
export interface RestingOrder extends ExitPlan {
  id: string;
  pair: string;
  side: 1 | -1;
  /** mid price; a buy fills when the ask reaches it, a sell when the bid does */
  limit: number;
  kind: 'limit' | 'pullback';
  placedAt: number;
  expiresAt: number;
  ref: string;
  strategy: string;
  stop: number;
  target: number | null;
  marginUsd: number;
  leverage: number;
  riskPct: number;
  conviction?: Conviction | null;
  sniper?: { votes: number; of: number } | null;
}

/** v16: a trade's sniper votes. */
export interface SniperTag {
  votes: number;
  of: number;
  /** votes needed (null = no level proved itself) */
  k: number | null;
  /** risks the sniper size */
  on: boolean;
  yes: string[];
}

/** v15.2: how sure the bot was of an entry, and what that earned it. */
export interface Conviction {
  tier: Tier;
  /** confirmations at the signal, out of `of` */
  conf: number;
  of: number;
  /** size multiple and leverage of its tier (1 / null = normal size) */
  mult: number;
  lev: number | null;
}

/** v15: the exit rules a bot position carries (copied from its lab trade). */
export interface ExitPlan {
  beAt?: number | null;
  scaleAt?: number | null;
  scaleFrac?: number | null;
  scaled?: boolean;
  tpTrailPx?: number | null;
  tpFrac?: number | null;
  tpHit?: boolean;
  tf?: string;
  trailPx?: number | null;
  trailAtr?: number | null;
  maxBars?: number | null;
  exitWhen?: string | null;
}

export interface OpenReq extends ExitPlan { /** v20: a market desk's learning trade */ desk?: boolean; /** v27.26 */ allIn?: boolean; pair: string; side: 1 | -1; marginUsd: number; leverage: number; stop?: number | null; target?: number | null; strategy?: string; ref?: string; riskPct?: number; conviction?: Conviction | null; sniper?: { votes: number; of: number } | null; bankedUsd?: number; /** v17: refuse a price older than this (default 30 min) */ maxQuoteAgeMs?: number; /** v17: an hourly / 4-hour trade may use a source's declared delay (Yahoo's metals) on top of the limit */ feedDelayOk?: boolean; /** v17: 1 R of a re-opened trade (else measured on this fill) */ riskUsd0?: number; /** v27.45: this trade's own $ loss cap */ maxLossUsd?: number; /** v27.46: no profit lock on this trade (a Discord copy follows its caller's exit) */ noLock?: boolean; /** v27.66 */ copyLock?: 'copy' | 'tight' }

/** The exit-plan fields of a lab trade, ready for `openIn`. Pure. */
export function planOf(t: LabOpenTrade): ExitPlan {
  return {
    beAt: t.beAt ?? null,
    scaleAt: t.scaleAt ?? null,
    scaleFrac: t.scaleFrac ?? null,
    scaled: !!t.scaled,
    tpTrailPx: t.tpTrailPx ?? null,
    tpFrac: t.tpFrac ?? null,
    tpHit: !!t.tpHit,
    ...(t.tf ? { tf: t.tf } : {}),
    trailPx: t.trailPx ?? null,
    trailAtr: t.trailAtr ?? null,
    maxBars: t.maxBars ?? null,
    exitWhen: t.exitWhen ?? null,
  };
}

/**
 * The bot's own record per strategy and chart: its newest 40 finished trades of the last 30 days (a dropped strategy
 * gets another chance once its losing trades are a month old). Pure.
 */
export function botRecordOf(a: PracticeAccount, now: number): Record<string, { n: number; pnlUsd: number }> {
  const out: Record<string, { n: number; pnlUsd: number }> = {};
  const st = a.stats ?? ensureStats({ ...a, stats: undefined });
  for (const [k, xs] of Object.entries(st)) {
    const recent = xs.filter(([t]) => now - t <= 30 * 86_400_000);
    if (recent.length) out[k] = { n: recent.length, pnlUsd: Math.round(recent.reduce((s, [, v]) => s + v, 0) * 100) / 100 };
  }
  return out;
}

/** v15: what one bot sync saw (for the plan's timeline and "held back" lists). */
export interface SyncReport {
  at: number;
  /** fresh signals of chosen strategies it could act on */
  candidates: number;
  opened: number;
  /** bot trades open in this call's charts */
  heldOpen: number;
  skipped: Array<{ pair: string; strategy: string; tf: string; side: 1 | -1; why: string }>;
  /** skipped only for now (news, rollover, full slots): the trade may still be taken while it is fresh */
  waits: Array<{ pair: string; strategy: string; tf: string; side: 1 | -1; why: string }>;
}
export const newSyncReport = (): SyncReport => ({ at: Date.now(), candidates: 0, opened: 0, heldOpen: 0, skipped: [], waits: [] });

/** v17.9: where live prices come from (v17.11: the freshest live stream, `liveFeed`; tests swap it) */
export interface LiveSource {
  get(id: string): { px: number; t: number; bars: Array<[number, number, number, number, number]>; source?: string } | null;
  flowing(now?: number): boolean;
}

export class Practice {
  private cache = new Map<string, Quote>();
  private timer: NodeJS.Timeout | null = null;
  /** v17.9: live currency-pair prices (seconds old) */
  live: LiveSource = liveFeed;
  /** v18: the pair's carry (base rate − quote rate, %) now — set by the lab from the policy rates it tests with */
  carryFor: (pair: string, t: number) => number = () => NaN;
  /** v27.66: big news for a market right now (index.ts: the calendar) → Kojiro copies there trail tight */
  tightNow: (pair: string, t: number) => string | null = () => null;
  /** v27.45: smarter $ loss caps per strategy × chart from the excursion study (set by the lab each hour; only used while
   * `active` — enough analysed trades) */
  slCaps: Partial<Record<AcctId, { active: boolean; def: number; byKey: Record<string, number> }>> = {};
  /** v17.9: yesterday's close per market (Yahoo, refreshed in the background ≤ every 30 min) for live prices' day change */
  private prev = new Map<string, { close: number; at: number }>();
  private checking = false;
  private lock: Promise<unknown> = Promise.resolve();
  /** v17: bot-log lines already written once (kept positions, resume retries) */
  private noted = new Set<string>();
  /** v17.8: accounts whose P&L log this process has checked (an empty log is filled once from the closed list) */
  private pnlReady = new Set<AcctId>();
  /** v17.8: parsed P&L log per account, dropped on every write to it (`pnlVer` guards a read racing a write) */
  private pnlCache = new Map<AcctId, PnlRow[]>();
  private pnlVer: Record<AcctId, number> = { me: 0, bot: 0, cbot: 0 };
  constructor(private readonly redis: Redis) {}

  start(): void {
    // v17.9 / v17.10: stops / targets every second while live prices flow (was 5 s; every 15 s otherwise); never two
    // checks at once
    let last = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      if (this.checking || (now - last < 15_000 && !this.live.flowing(now))) return;
      last = now;
      this.checking = true;
      void this.serial(() => this.checkOpen())
        .catch(() => undefined)
        .finally(() => (this.checking = false));
    }, 1_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** one account change at a time */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  async quote(id: string, maxAgeMs = 15_000): Promise<Quote | null> {
    const c = this.cache.get(id);
    const inst = instrument(id);
    if (!inst) return null;
    // v17.9: a live streamed price first for currency pairs (seconds old; synthetic spread like Yahoo's). Metals never:
    // the lab tests them on COMEX futures (Pyth's are spot, Yahoo's streamed futures are delayed).
    if (inst.kind === 'fx' || inst.kind === 'crypto') {
      const lp = this.live.get(id);
      if (lp) {
        const now = Date.now();
        const half = syntheticHalf(inst, now);
        const pc = this.prev.get(id) ?? (c?.prevClose ? { close: c.prevClose, at: c.t } : undefined);
        if (!pc || now - pc.at > 30 * 60_000) this.refreshPrev(inst, now);
        const q: Quote = { id, mid: lp.px, bid: lp.px - half, ask: lp.px + half, t: now, bars: lp.bars, dayChangePct: pc ? Math.round((lp.px / pc.close - 1) * 10_000) / 100 : null, source: lp.source === 'yahoo-live' ? 'yahoo-live' : 'pyth', priceT: lp.t, ...(pc ? { prevClose: pc.close } : {}) };
        this.cache.set(id, q);
        return q;
      }
    }
    // v27.48: indices / metals live from Hyperliquid's builder markets + the measured gap (Yahoo's are ~10 min late)
    if (needsBasis(id)) {
      const hq = this.hlQuote(inst, Date.now());
      if (hq) {
        this.cache.set(id, hq);
        return hq;
      }
    }
    if (c && Date.now() - c.t < maxAgeMs && c.source !== 'pyth' && c.source !== 'yahoo-live' && c.source !== 'hyperliquid') return c;
    let q = feeds.allow('yahoo') ? await fetchQuote(inst) : null;
    if (q) {
      this.cache.set(id, q);
      feeds.ok('yahoo-quotes', { items: q.bars.length, asOf: q.priceT ?? null });
    } else if (feeds.allow('yahoo')) feeds.fail('yahoo-quotes', `no price for ${id}`);
    // v17: Yahoo failed → Dukascopy's 1-minute candles for a currency pair (real bid / ask), before any stale cache
    if (!q && inst.kind === 'fx') {
      const d = await dkQuote(inst.id).catch(() => null);
      if (d) {
        const mid = (d.bid + d.ask) / 2;
        q = { id: inst.id, mid, bid: d.bid, ask: d.ask, t: Date.now(), bars: d.bars, dayChangePct: c?.dayChangePct ?? null, source: 'dukascopy', priceT: d.priceT };
        this.cache.set(id, q);
      }
    }
    return q ?? (c ? { ...c, stale: true } : null);
  }

  /** v17.9: yesterday's close for a live price's day change — a background Yahoo read, at most once per 30 min a market */
  private refreshPrev(inst: Instrument, now: number): void {
    const had = this.prev.get(inst.id);
    this.prev.set(inst.id, { close: had?.close ?? NaN, at: now });
    if (!feeds.allow('yahoo')) return;
    void fetchQuote(inst)
      .then((q) => {
        if (q?.prevClose) this.prev.set(inst.id, { close: q.prevClose, at: Date.now() });
        else if (!had) this.prev.delete(inst.id);
      })
      .catch(() => undefined);
  }

  async quotes(ids: readonly string[] = INSTRUMENTS.map((i) => i.id), maxAgeMs = 15_000): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    const s = await loadOanda();
    if (oandaReady(s)) {
      try {
        const now = Date.now();
        // v27.47: OANDA's names for the indices; coins stay on Coinbase; a futures market (indices, metals) only once its
        // gap to the futures price is measured (basis.ts) — until then Yahoo's delayed futures price, as before
        const viaOanda = ids.filter((id) => oandaCovers(id, now) && (!needsBasis(id) || this.basisFor(id, 'oanda', now, s) !== null));
        const fresh = viaOanda.filter((id) => {
          const c = this.cache.get(id);
          return !c || c.source !== 'oanda' || Date.now() - c.t > 2_000;
        });
        if (fresh.length) {
          const prices = await oandaPrices(s, fresh);
          await Promise.all(prices.map(async (p) => {
            const b = needsBasis(p.id) ? this.basisFor(p.id, 'oanda', now, s) : 0;
            if (b === null) return;
            const prev = this.cache.get(p.id);
            // 1-minute bars for stop / target checks: refreshed at most every 20 s
            let bars = prev?.source === 'oanda' && Date.now() - (prev.barsAt ?? 0) < 20_000 ? prev.bars : null;
            let barsAt = prev?.barsAt ?? 0;
            if (!bars) {
              const cs = await oandaCandles(s, p.id, 'M1', 180).catch(() => []);
              bars = shiftBars(cs.map((c) => [c.t, c.h, c.l, c.c, c.o] as [number, number, number, number, number]), b);
              barsAt = Date.now();
            }
            const mid = (p.bid + p.ask) / 2 + b;
            this.cache.set(p.id, { id: p.id, mid, bid: p.bid + b, ask: p.ask + b, t: Date.now(), bars, dayChangePct: prev?.dayChangePct ?? null, source: 'oanda', barsAt, priceT: p.t, tradeable: p.tradeable });
          }));
        }
        for (const id of viaOanda) {
          const c = this.cache.get(id);
          // v17: a price OANDA didn't refresh this time is marked old (never used to open or close)
          if (c && c.source === 'oanda') out[id] = Date.now() - c.t > 15_000 ? { ...c, stale: true } : c;
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'oanda prices failed, using yahoo');
      }
    }
    // v27.47: every market OANDA didn't price (coins, a market it refused, a futures market without a measured gap)
    // still gets its normal price — before, those were simply missing while OANDA was connected
    await Promise.all(ids.filter((id) => !out[id]).map(async (id) => {
      const q = await this.quote(id, maxAgeMs);
      if (q) out[id] = q;
    }));
    return out;
  }

  /** v27.47: futures − OANDA / Hyperliquid gap per market (basis.ts, key `src:id`); measured in the background, null
   * until known / when too old */
  private basis = new Map<string, BasisRow>();
  private basisTried = new Map<string, number>();
  /** v27.48: Hyperliquid's builder index / metal markets (swappable for tests) */
  hl: Pick<typeof hyperliquidLive, 'book' | 'candles' | 'futBars'> = hyperliquidLive;
  /** v27.56: a futures market's real-time candles from its Hyperliquid builder market (unshifted; [] when it has none) —
   * swappable for tests */
  hlBars: (id: string, interval: '1m' | '5m' | '15m' | '1h' | '4h', from: number, to: number) => Promise<Bar[]> = async (id, interval, from, to) => {
    const coin = hyperliquidLive.futuresFound()[id];
    return coin ? hlCandles(coin, interval, from, to) : [];
  };
  /** v27.52: the futures − Hyperliquid gap for one market (null = not measured yet; asking starts a measurement) */
  hlGap(id: string, now = Date.now()): number | null {
    return this.basisFor(id, 'hl', now);
  }
  private basisFor(id: string, src: 'oanda' | 'hl', now: number, s?: OandaSettings): number | null {
    const key = `${src}:${id}`;
    const r = this.basis.get(key);
    if ((!r || now - r.at > BASIS.refreshMs) && now - (this.basisTried.get(key) ?? 0) > 60_000) {
      this.basisTried.set(key, now);
      void this.measureBasisFor(id, src, s);
    }
    return r && now - r.at <= BASIS.maxAgeMs ? r.basis : null;
  }
  private async measureBasisFor(id: string, src: 'oanda' | 'hl', s?: OandaSettings): Promise<void> {
    const inst = instrument(id);
    if (!inst || !feeds.allow('yahoo')) return;
    try {
      const other: Promise<Array<readonly [number, number]>> =
        src === 'oanda' ? oandaCandles(s!, id, 'M1', 300).then((oc) => oc.filter((c) => c.complete).map((c) => [c.t, c.c] as const)) : this.hl.candles(id, 300);
      const [yq, rows] = await Promise.all([fetchQuote(inst), other]);
      if (!yq) return;
      const m = measureBasis(yq.bars.map((b) => [b[0], b[3]] as const), rows);
      if (!m) return;
      const key = `${src}:${id}`;
      const had = this.basis.get(key);
      this.basis.set(key, { ...m, at: Date.now() });
      if (!had) log.info({ id, src, basis: Math.round(m.basis * 100) / 100, n: m.n }, 'live price in use (futures gap measured)');
    } catch (err) {
      log.warn({ id, src, err: (err as Error).message }, 'futures gap not measured');
    }
  }
  /** v27.48: a futures market's live price from Hyperliquid's builder market + the gap (null when either is missing or the
   * CME market is closed — weekends, the daily halt: the builder market keeps trading on its own then) */
  private hlQuote(inst: Instrument, now: number): Quote | null {
    const book = this.hl.book(inst.id, now);
    if (!book || !clockFor(inst.id, now).open) return null;
    const b = this.basisFor(inst.id, 'hl', now);
    if (b === null) return null;
    const prev = this.cache.get(inst.id);
    return { id: inst.id, mid: (book.bid + book.ask) / 2 + b, bid: book.bid + b, ask: book.ask + b, t: now, bars: shiftBars(this.hl.futBars(inst.id), b), dayChangePct: prev?.dayChangePct ?? null, source: 'hyperliquid', priceT: book.t, ...(prev?.prevClose ? { prevClose: prev.prevClose } : {}) };
  }
  /** v27.75: a futures market's live price (Hyperliquid + the gap) for the dashboard's ticking P&L — the same price the
   * account itself uses (null when it wouldn't: no book, CME closed, no gap measured) */
  liveFutTick(id: string, now = Date.now()): LiveTick | null {
    const inst = instrument(id);
    const q = inst ? this.hlQuote(inst, now) : null;
    return q ? { id, mid: q.mid, conf: (q.ask - q.bid) / 2, t: q.priceT ?? now } : null;
  }
  /** v27.47: the measured gaps, for Setup */
  basisNow(): Record<string, BasisRow & { src: 'oanda' | 'hl' }> {
    const out: Record<string, BasisRow & { src: 'oanda' | 'hl' }> = {};
    for (const [key, r] of this.basis) {
      const [src, id] = key.split(':') as ['oanda' | 'hl', string];
      if (!out[id] || src === 'oanda') out[id] = { ...r, src };
    }
    return out;
  }

  /**
   * v17: a Redis error (or an unreadable account) THROWS — it used to hand back a fresh $1,000 account, and the next save
   * wiped the real one. Only a missing key is a new account.
   */
  private async load(acct: AcctId = 'me'): Promise<PracticeAccount> {
    const raw = await this.redis.get(keyFor(acct));
    if (raw === null) return newAccount();
    try {
      return JSON.parse(raw) as PracticeAccount;
    } catch (err) {
      log.error({ acct, err: (err as Error).message }, 'practice account unreadable — not touching it');
      throw new Error('practice account unreadable');
    }
  }
  /**
   * v17.8: the account and the closes it booked since it was loaded go to Redis in ONE transaction (account + P&L log
   * rows) — a close is in the log exactly when it is in the stored account: a retry, a restart or the same account saved
   * twice never logs it again, a failed save logs nothing. The first write of this process fills an empty log once from
   * the account's closed list (oldest first). `clearLog` (reset) empties the log with the account.
   */
  private async save(a: PracticeAccount, acct: AcctId = 'me', opts: { clearLog?: boolean } = {}): Promise<void> {
    if (!this.pnlLogs()) {
      await this.redis.set(keyFor(acct), JSON.stringify(a));
      pnlQueue.delete(a);
      this.publishNotices(a, acct);
      return;
    }
    const key = pnlKey(acct);
    let rows = opts.clearLog ? [] : pnlQueue.get(a) ?? [];
    if (!opts.clearLog && !this.pnlReady.has(acct) && (await this.redis.llen(key)) === 0) rows = [...a.closed].reverse().map(pnlRowOf);
    const m = this.redis.multi().set(keyFor(acct), JSON.stringify(a));
    if (opts.clearLog) m.del(key);
    if (rows.length) m.rpush(key, ...rows.map((r) => JSON.stringify(r))).ltrim(key, -PNL_KEEP, -1);
    const res = await m.exec();
    if (!res) throw new Error('practice save aborted');
    if (res[0]?.[0]) throw res[0][0];
    const err = res.slice(1).find(([e]) => e)?.[0];
    if (err) log.error({ acct, err: err.message }, 'P&L log write failed (the account was saved)');
    pnlQueue.delete(a);
    this.pnlReady.add(acct);
    if (rows.length || opts.clearLog) this.pnlDirty(acct);
    this.publishNotices(a, acct);
  }
  /** v17.12: the account is written — its trade alerts go out (phone notifications, the dashboard) */
  private publishNotices(a: PracticeAccount, acct: AcctId): void {
    for (const n of takeNotices(a)) bus.publish({ type: 'fxTrade', data: { ...n, acct } });
  }
  /** v17.8: the P&L log needs list + transaction support (a bare get / set client just saves the account) */
  private pnlLogs(): boolean {
    const r = this.redis as unknown as Record<string, unknown>;
    return typeof r.multi === 'function' && typeof r.llen === 'function' && typeof r.lrange === 'function';
  }
  private pnlDirty(acct: AcctId): void {
    this.pnlVer[acct]++;
    this.pnlCache.delete(acct);
  }
  /** v17.8: an empty log is filled once from the account's closed list (newest 200) — before the first read too. */
  private async seedPnl(acct: AcctId): Promise<void> {
    if (this.pnlReady.has(acct)) return;
    const key = pnlKey(acct);
    const a = await this.load(acct);
    if (a.closed.length && (await this.redis.llen(key)) === 0) {
      const res = await this.redis.multi().rpush(key, ...[...a.closed].reverse().map((c) => JSON.stringify(pnlRowOf(c)))).ltrim(key, -PNL_KEEP, -1).exec();
      const err = res ? res.find(([e]) => e)?.[0] : new Error('aborted');
      if (err) throw err;
      this.pnlDirty(acct);
    }
    this.pnlReady.add(acct);
  }

  /** v17.8: every booked close of the account (full closes, parts taken, weekend legs), oldest first. */
  async pnlRows(acct: AcctId = 'bot'): Promise<PnlRow[]> {
    if (!this.pnlLogs()) return [];
    const hit = this.pnlCache.get(acct);
    if (hit) return hit;
    // a fill that fails (account unreadable) never hides what the log already holds; it is tried again next time
    if (!this.pnlReady.has(acct)) await this.serial(() => this.seedPnl(acct)).catch((err: Error) => log.warn({ acct, err: err.message }, 'P&L log fill failed'));
    const ver = this.pnlVer[acct];
    const raw = await this.redis.lrange(pnlKey(acct), 0, -1);
    const rows = raw.map(parsePnlRow).filter((r): r is PnlRow => r !== null).sort((x, y) => x.t - y.t);
    if (ver === this.pnlVer[acct]) this.pnlCache.set(acct, rows);
    return rows;
  }

  /** Quotes needed to value the account: its pairs + the USD legs for conversion. */
  private neededIds(a: PracticeAccount, extra: string[] = []): string[] {
    const s = new Set<string>(extra);
    for (const p of a.open) s.add(p.pair);
    for (const id of [...s]) {
      const i = instrument(id);
      if (!i || i.kind !== 'fx') continue;
      for (const ccy of [i.id.slice(0, 3), i.id.slice(3, 6)]) {
        if (ccy === 'USD') continue;
        if (instrument(`${ccy}USD`)) s.add(`${ccy}USD`);
        else if (instrument(`USD${ccy}`)) s.add(`USD${ccy}`);
      }
    }
    return [...s];
  }

  private async checkOpen(): Promise<void> {
    // v17: one account failing to load never stops the other's stops / targets / weekend flatten
    for (const acct of ['me', 'bot', 'cbot'] as AcctId[]) await this.checkOne(acct).catch((err: Error) => log.error({ acct, err: err.message }, 'practice check failed'));
  }

  private async checkOne(acct: AcctId): Promise<void> {
    const a = await this.load(acct);
    if (!a.open.length && !a.orders?.length) return;
    const q = await this.quotes(this.neededIds(a, (a.orders ?? []).map((o) => o.pair)));
    const mv = { moved: false };
    const ev = tick(a, q, Date.now(), mv, this.carryFor, this.tightNow);
    // v18.4: nothing rests over the weekend
    // v22: coins have no weekend — only currency / metal orders and positions are flattened
    if (acct !== 'me' && marketClock(Date.now()).flattenNow && a.orders?.some((o) => !isCrypto(o.pair))) {
      const n = a.orders.filter((o) => !isCrypto(o.pair)).length;
      ev.push(`cancelled ${n} limit order${n > 1 ? 's' : ''} for the weekend`);
      a.orders = a.orders.filter((o) => isCrypto(o.pair));
    }
    if (acct !== 'me' && marketClock(Date.now()).flattenNow && a.open.some((p) => !isCrypto(p.pair))) {
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      for (const p of [...a.open]) {
        if (isCrypto(p.pair)) continue; // v22: a coin position rides through the weekend
        // v17: at the live price, else the last price this process saw (never the entry price); none at all → it
        // closes at the first price that arrives
        const qq = q[p.pair] ?? this.cache.get(p.pair);
        if (!qq) {
          if (!p.closePending) p.closePending = { reason: 'weekend', at: Date.now() };
          continue;
        }
        // a close already asked for (by hand, or the strategy's exit) finishes as that — it never comes back Monday
        if (p.closePending && p.closePending.reason !== 'weekend') {
          closePos(a, p, p.side === 1 ? qq.bid : qq.ask, mids, p.closePending.reason, Date.now());
          continue;
        }
        const leg = closePos(a, p, p.side === 1 ? qq.bid : qq.ask, mids, 'weekend', Date.now());
        if (pausable(p)) a.resume = [...(a.resume ?? []), resumeItemOf(p, leg, Date.now())];
        else recordTrade(a, statKey(p), Date.now(), leg + (p.bankedUsd ?? 0), copyRec(p));
      }
      ev.push('weekend: every bot trade closed before the Friday close (re-opened after Monday\'s open if still running)');
    }
    if (ev.length) log.info({ acct, ev }, 'practice account event');
    if (ev.length || mv.moved) await this.save(a, acct);
  }

  /** v17.14: the open trades valued at the newest prices + those quotes (1-minute candles) — reads only, saves nothing
   * (the 1-second check books stops / targets) */
  async openNow(acct: AcctId): Promise<{ positions: AccountView['positions']; quotes: Record<string, Quote> }> {
    const a = await this.load(acct);
    if (!a.open.length) return { positions: [], quotes: {} };
    const q = await this.quotes(this.neededIds(a));
    const mids: Record<string, number> = {};
    const halves: Record<string, number> = {};
    for (const x of Object.values(q)) {
      mids[x.id] = x.mid;
      halves[x.id] = (x.ask - x.bid) / 2;
    }
    return { positions: view(a, mids, halves).positions, quotes: q };
  }

  async snapshot(acct: AcctId = 'me'): Promise<{ account: AccountView; quotes: Record<string, Quote> }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const q = await this.quotes(INSTRUMENTS.map((i) => i.id), 20_000);
      const mv = { moved: false };
      if (tick(a, q, Date.now(), mv, this.carryFor, this.tightNow).length || mv.moved) await this.save(a, acct);
      const mids: Record<string, number> = {};
      const halves: Record<string, number> = {};
      for (const x of Object.values(q)) {
        mids[x.id] = x.mid;
        halves[x.id] = (x.ask - x.bid) / 2;
      }
      // v27.75 (owner: "the live price is being delayed"): how old each open trade's price is (Dow / Russell / silver run on
      // Yahoo's ~10-minute-late CME price when Hyperliquid has no market for them) — the dashboard says so
      const now = Date.now();
      const v = view(a, mids, halves);
      return { account: { ...v, positions: v.positions.map((p) => (q[p.pair] ? { ...p, priceAgeMs: Math.max(0, quoteAge(q[p.pair]!, now)) } : p)) }, quotes: q };
    });
  }

  async open(req: OpenReq, acct: AcctId = 'me'): Promise<{ ok: boolean; error?: string }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = await this.openIn(a, req);
      if (r.ok) await this.save(a, acct);
      return r;
    });
  }

  private async openIn(a: PracticeAccount, req: OpenReq): Promise<{ ok: boolean; error?: string }> {
    {
      const inst = instrument(req.pair);
      if (!inst) return { ok: false, error: 'unknown market' };
      const lev = Math.round(req.leverage);
      if (!(lev >= 1 && lev <= MAX_LEVERAGE)) return { ok: false, error: `leverage 1–${MAX_LEVERAGE}` };
      if (!(req.marginUsd > 0)) return { ok: false, error: 'amount must be above 0' };
      const q = await this.quotes(this.neededIds(a, [inst.id]), 10_000);
      const quote = q[inst.id];
      if (!quote) return { ok: false, error: 'no price right now (market closed or feed down)' };
      if (quote.stale) return { ok: false, error: 'the price feed failed just now (only an older price): not opening on it' };
      if (quote.tradeable === false || quoteAge(quote, Date.now()) > 30 * 60_000) return { ok: false, error: 'market is closed right now (forex: Sunday 22:00 – Friday 22:00 UTC)' };
      const delay = Math.max(quote.delayMs ?? 0, isFutures(inst.id) ? BOT.futuresDelayMs : 0);
      const allowed = req.maxQuoteAgeMs === undefined ? Infinity : req.maxQuoteAgeMs + (req.feedDelayOk ? delay : 0);
      if (quoteAge(quote, Date.now()) > allowed) return { ok: false, error: `the newest price is ${Math.round(quoteAge(quote, Date.now()) / 60_000)} min old${delay ? ` (${Math.round(delay / 60_000)}-min delayed feed)` : ''} (this chart needs ≤ ${Math.round((req.maxQuoteAgeMs ?? 0) / 60_000)} min)` };
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      const v = view(a, mids, { [inst.id]: (quote.ask - quote.bid) / 2 });
      if (req.marginUsd > v.freeMarginUsd) return { ok: false, error: `not enough free margin ($${v.freeMarginUsd})` };
      const entry = req.side === 1 ? quote.ask : quote.bid;
      const units = unitsFor(inst, req.marginUsd * lev, mids);
      if (!units) return { ok: false, error: 'no conversion price' };
      const stop = req.stop ?? null;
      const target = req.target ?? null;
      if (stop !== null && (req.side === 1 ? stop >= entry : stop <= entry)) return { ok: false, error: 'stop must be on the losing side of the price' };
      if (target !== null && (req.side === 1 ? target <= entry : target >= entry)) return { ok: false, error: 'target must be on the winning side of the price' };
      // v17: 1 R = what the stop would lose, measured on this fill (a re-opened weekend leg keeps the original trade's)
      const riskUsd0 = req.riskUsd0 && req.riskUsd0 > 0 ? req.riskUsd0 : stop !== null ? Math.round(positionRiskUsd({ pair: inst.id, side: req.side, units, entry, stop }, mids) * 100) / 100 : 0;
      a.open.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        pair: inst.id,
        side: req.side,
        units,
        entry,
        marginUsd: Math.round(req.marginUsd * 100) / 100,
        leverage: lev,
        stop,
        target,
        openedAt: Date.now(),
        checkedT: quote.bars[quote.bars.length - 1]?.[0] ?? Date.now(),
        ...(req.strategy ? { strategy: req.strategy } : {}),
        ...(req.ref ? { ref: req.ref } : {}),
        ...(req.maxLossUsd && req.maxLossUsd > 0 && !req.allIn ? { maxLossUsd: req.maxLossUsd } : {}),
        ...(req.riskPct !== undefined ? { riskPct: req.riskPct } : {}),
        ...(req.conviction ? { conviction: req.conviction } : {}),
        ...(req.desk ? { desk: true } : {}),
        ...(req.allIn ? { allIn: true } : {}),
        ...(req.sniper ? { sniper: req.sniper } : {}),
        ...(req.bankedUsd ? { bankedUsd: req.bankedUsd } : {}),
        ...(req.beAt != null ? { beAt: req.beAt } : {}),
        ...(req.scaleAt != null ? { scaleAt: req.scaleAt, scaleFrac: req.scaleFrac ?? 0.5, scaled: !!req.scaled } : {}),
        ...(req.tpTrailPx != null ? { tpTrailPx: req.tpTrailPx, tpFrac: req.tpFrac ?? 0, tpHit: !!req.tpHit } : {}),
        ...(req.tf ? { tf: req.tf } : {}),
        ...(req.trailPx != null ? { trailPx: req.trailPx } : {}),
        ...(req.trailAtr != null ? { trailAtr: req.trailAtr } : {}),
        ...(req.maxBars != null ? { maxBars: req.maxBars } : {}),
        ...(req.exitWhen ? { exitWhen: req.exitWhen } : {}),
        ...(req.ref && riskUsd0 > 0 ? { riskUsd0 } : {}),
        ...(req.noLock ? { lock: null } : {}),
        ...(req.copyLock === 'tight' ? { copyLock: 'tight' as const } : {}),
      });
      // v27.30 (owner: "a notification when it enters a trade"): bot trades only (they carry a lab ref)
      if (req.ref) {
        const pos = { pair: inst.id, side: req.side, units, entry };
        notice(a, { kind: 'open', pair: inst.id, side: req.side, pnlUsd: 0, stopPnlUsd: stop !== null ? Math.round(pnlUsd(pos, stop, mids) * 100) / 100 : null, targetPnlUsd: target !== null ? Math.round(pnlUsd(pos, target, mids) * 100) / 100 : null, strategy: req.strategy ?? null, tf: req.tf ?? null, riskPct: req.riskPct ?? null });
      }
      return { ok: true };
    }
  }

  /**
   * Bot account: mirror the lab's live paper trades of the chosen strategies. A trade the lab opened moments ago
   * (`BOT.freshMsByTf`) that the bot doesn't hold yet is opened at the current price with the same stop / target. Size
   * (v13): base risk × the lab's size factor (strategy record × how wild the market is) × a drawdown factor, never more
   * than `BOT.maxCcyRiskPct` of the account on one currency in one direction. Held trades follow the lab's trailing
   * stop; one the lab no longer has open (its trail / time / signal exit fired) is closed at the market. v15: `scope` =
   * the charts this call manages (the hourly lab passes 1h + 4h, the fast lab 15m or 1m), so one never closes the
   * other's trades; `report` collects what it saw for the bot's plan.
   */
  async syncBot(labOpen: LabOpenTrade[], blockFor: (pair: string, strategy?: string) => string | null = () => null, atr1h: Record<string, number> = {}, opts: { scope?: readonly string[]; report?: SyncReport; pairsSeen?: ReadonlySet<string>; heat?: HeatLive | null; acct?: 'bot' | 'cbot'; labDone?: ReadonlySet<string> } = {}): Promise<string[]> {
    const inScope = (ref: string | undefined) => !opts.scope || opts.scope.includes(tfOfRef(ref));
    const rep = opts.report;
    return this.serial(async () => {
      const acct: AcctId = opts.acct ?? 'bot'; // v22.1: the forex bot or the coin bot
      const a = await this.load(acct);
      const L = limitsFor(a.riskMode);
      const capUsd = BOT.maxLossUsdByAcct[acct];
      if ((a.maxLossUsd ?? undefined) !== capUsd) {
        if (capUsd) a.maxLossUsd = capUsd;
        else delete a.maxLossUsd;
      }
      const events: string[] = [];
      const byRef = new Map(labOpen.map((t) => [t.ref, t]));
      const q = await this.quotes(this.neededIds(a, [...new Set(labOpen.map((t) => t.pair))]), 10_000);
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      const pxNow = (pair: string, side: 1 | -1) => {
        const qq = q[pair];
        // v17: an old cached price is never used to close anything
        return qq && !qq.stale ? (side === 1 ? qq.bid : qq.ask) : null;
      };
      // v18.4: a resting order whose lab trade ended (or whose limit moved) is cancelled; a filled one is a position now
      if (a.orders?.length) {
        const keep: RestingOrder[] = [];
        for (const o of a.orders) {
          if (!inScope(o.ref)) {
            keep.push(o);
            continue;
          }
          const lab = byRef.get(o.ref);
          if (!lab && opts.pairsSeen && !opts.pairsSeen.has(o.pair)) {
            keep.push(o);
            continue;
          }
          if (!lab || !lab.order) {
            events.push(`cancelled the ${o.pair} (${o.strategy}) limit order: its signal is over`);
            continue;
          }
          keep.push(o);
        }
        a.orders = keep;
      }
      let moved = 0;
      for (const p of [...a.open]) {
        if (!p.ref || !inScope(p.ref)) continue;
        const lab = byRef.get(p.ref);
        if (!lab) {
          // v17: the lab had no candles for this market this time → it can't know the trade ended: keep it
          if (opts.pairsSeen && !opts.pairsSeen.has(p.pair)) {
            if (!this.noted.has(`kept:${p.ref}`)) {
              this.noted.add(`kept:${p.ref}`);
              events.push(`kept ${p.pair} (${p.strategy}): no fresh candles for it this check, its stop / target still guard it`);
            }
            continue;
          }
          this.noted.delete(`kept:${p.ref}`);
          // v26.2: the lab's trade is gone but it never FINISHED there (a re-test after an update changed the strategy's
          // filter / exit, so the signal no longer exists) → not a real exit: keep it on its own stop / target / lock
          if (opts.labDone && !opts.labDone.has(p.ref)) {
            const barMs = (TF_MIN[(p.tf ?? tfOfRef(p.ref)) as Timeframe] ?? 60) * 60_000;
            if (Date.now() - p.openedAt < BOT.orphanMaxBars * barMs) {
              if (!this.noted.has(`orphan:${p.ref}`)) {
                this.noted.add(`orphan:${p.ref}`);
                events.push(`kept ${p.pair} (${p.strategy}): a re-test changed its strategy's rules, but its own trade didn't end — its stop, target and profit lock run it`);
              }
              continue;
            }
          }
          this.noted.delete(`orphan:${p.ref}`);
          const px = pxNow(p.pair, p.side);
          if (px === null) {
            if (!p.closePending) {
              p.closePending = { reason: 'signal', at: Date.now() };
              events.push(`${p.pair} (${p.strategy}): its strategy's exit fired but there's no live price — it closes at the first one`);
            }
            continue;
          }
          closePos(a, p, px, mids, 'signal', Date.now());
          events.push(`closed ${p.pair} (${p.strategy}): its strategy's exit fired`);
          continue;
        }
        // v15: the lab's trade reached its target on the strategy's chart → trailing take-profit here too
        if (lab.tpHit && !p.tpHit && p.tpTrailPx != null) {
          const px = pxNow(p.pair, p.side);
          const frac = Math.min(0.9, Math.max(0, p.tpFrac ?? 0));
          if (frac > 0 && px !== null) closePart(a, p, frac, px, mids, Date.now());
          p.tpHit = true;
          p.be = true;
          p.target = null;
          events.push(`${p.pair} (${p.strategy}) reached its target on the ${lab.tf ?? ''} chart${frac > 0 ? `: took ${Math.round(frac * 100)}% off` : ''}, now trailing`);
        }
        // the exit rules still in force (for the plan)
        p.trailPx = lab.trailPx ?? null;
        p.trailAtr = lab.trailAtr ?? null;
        p.maxBars = lab.maxBars ?? null;
        p.exitWhen = lab.exitWhen ?? null;
        // follow the lab's trailing stop: only ever tighter; when the price is already past it (the lab's own check will
        // close the trade at its next candle) close now instead of keeping the looser stop
        if (p.stop !== null && (p.side === 1 ? lab.stop > p.stop : lab.stop < p.stop)) {
          const px = pxNow(p.pair, p.side);
          if (px === null || (p.side === 1 ? lab.stop < px : lab.stop > px)) {
            p.stop = lab.stop;
            moved++;
          } else {
            closePos(a, p, px, mids, 'stop', Date.now());
            events.push(`closed ${p.pair} (${p.strategy}): the price is already past its trailing stop`);
          }
        }
      }
      if (moved) events.push(`trailed the stop on ${moved} open trade${moved > 1 ? 's' : ''}`);
      const v0 = view(a, mids);
      a.peakUsd = Math.max(a.peakUsd ?? a.startUsd, v0.equityUsd);
      const ddPct = a.peakUsd > 0 ? Math.max(0, (1 - v0.equityUsd / a.peakUsd) * 100) : 0;
      const ddF = ddFactor(ddPct);
      const held = new Set([...a.open.map((p) => p.ref), ...(a.orders ?? []).map((o) => o.ref), ...a.closed.slice(0, 200).map((p) => p.ref)]);
      const clock = marketClock(Date.now());
      const noted = new Set<string>();
      const note = (key: string, e: string) => {
        if (!noted.has(key)) events.push(e);
        noted.add(key);
      };
      const canOpen = clock.open && !clock.noNewTrades && !clock.rollover && clock.sinceOpenMin >= 120;
      /** v22: a coin market is always open — its candidates never wait on the forex clock */
      const canOpenFor = (pair: string) => canOpen || isCrypto(pair);
      // v14: trades paused for the weekend come back once Monday's market has settled, if the lab still holds them
      if (a.resume?.length) {
        const keep: ResumeItem[] = [];
        for (const r of a.resume) {
          if (!inScope(r.ref)) {
            keep.push(r);
            continue;
          }
          const done = () => recordTrade(a, r.strategy ? `${r.strategy}:${tfOfRef(r.ref) || '1h'}` : null, Date.now(), r.bankedUsd ?? 0, { ref: r.ref, ...(r.riskUsd0 ? { riskUsd0: r.riskUsd0 } : {}), why: 'weekend' });
          if (Date.now() - r.at > 4 * 86_400_000) {
            done();
            continue;
          }
          const lab = byRef.get(r.ref);
          if (!lab && opts.pairsSeen && !opts.pairsSeen.has(r.pair)) {
            keep.push(r);
            continue;
          }
          if (!lab) {
            events.push(`${r.pair} (${r.strategy ?? 'bot'}) ended over the weekend, not re-opened`);
            done();
            continue;
          }
          if (!canOpenFor(r.pair)) {
            keep.push(r);
            continue;
          }
          const qq = q[r.pair];
          if (!qq || qq.tradeable === false) {
            keep.push(r);
            continue;
          }
          const entry = r.side === 1 ? qq.ask : qq.bid;
          const dist = (entry - lab.stop) * r.side;
          if (!(dist > 0) || (lab.target !== null && (r.side === 1 ? entry >= lab.target : entry <= lab.target))) {
            events.push(`${r.pair} (${r.strategy ?? 'bot'}) moved past its stop / target over the weekend, not re-opened`);
            done();
            continue;
          }
          const v = view(a, mids);
          const left = (r.scaled ? 1 - (lab.scaleFrac ?? 0.5) : 1) * (r.tpHit && lab.tpFrac ? 1 - lab.tpFrac : 1);
          const risk = (r.riskPct ?? L.riskPct) * left;
          const rlev = r.lev ?? L.leverage;
          const margin = Math.min((v.equityUsd * risk) / 100 / (dist / entry) / rlev, v.freeMarginUsd * SIZING.marginShare);
          if (margin < 1) {
            events.push(`${r.pair} (${r.strategy ?? 'bot'}): the account is too small to re-open it after the weekend`);
            done();
            continue;
          }
          const res = await this.openIn(a, { pair: r.pair, side: r.side, marginUsd: margin, leverage: rlev, stop: lab.stop, target: lab.target, ...(r.strategy ? { strategy: r.strategy } : {}), ref: r.ref, riskPct: Math.round(risk * 100) / 100, ...planOf(lab), scaled: !!r.scaled || !!lab.scaled, tpHit: !!r.tpHit || !!lab.tpHit, bankedUsd: r.bankedUsd ?? 0, ...(r.riskUsd0 ? { riskUsd0: r.riskUsd0 } : {}), maxQuoteAgeMs: BOT.quoteAgeMsByTf[tfOfRef(r.ref)] ?? 10 * 60_000, feedDelayOk: ['1h', '4h'].includes(tfOfRef(r.ref)) });
          if (res.ok) events.push(`re-opened ${r.side === 1 ? 'long' : 'short'} ${r.pair} (${r.strategy ?? 'bot'}) after the weekend`);
          else {
            // v17: a price hiccup is not the end of the trade — try again at the next check (4-day limit above)
            keep.push(r);
            if (!this.noted.has(`resume:${r.ref}`)) {
              this.noted.add(`resume:${r.ref}`);
              events.push(`could not re-open ${r.pair} yet: ${res.error} (will retry)`);
            }
          }
        }
        a.resume = keep;
      }
      // best-tested signals get the free slots first; one strategy holds at most `maxPerStrategy` trades, one chart its cap
      const stratKey = (ref: string) => ref.split(':').slice(0, 2).join(':');
      const perStrategy = new Map<string, number>();
      const perTf = new Map<string, number>();
      for (const p of [...a.open, ...(a.orders ?? [])]) {
        if (!p.ref) continue;
        perStrategy.set(stratKey(p.ref), (perStrategy.get(stratKey(p.ref)) ?? 0) + 1);
        perTf.set(tfOfRef(p.ref), (perTf.get(tfOfRef(p.ref)) ?? 0) + 1);
      }
      const fresh = (t: LabOpenTrade) => Date.now() - t.entryT <= (BOT.freshMsByTf[t.tf ?? tfOfRef(t.ref)] ?? BOT.freshMs);
      const struck = new Set(a.skipRefs ?? []); // v27.22: struck by the owner
      const candidates = labOpen.filter((t) => t.chosen && !held.has(t.ref) && !struck.has(t.ref) && fresh(t)).sort((x, y) => (y.prio ?? 0) - (x.prio ?? 0));
      // v27.38 the daily trade cap
      const dayCap = BOT.maxTradesPerDay[acct] ?? 0;
      let openedToday = tradesOpenedToday(a, Date.now());
      const hourCap = BOT.maxTradesPerHour[acct] ?? 0;
      let openedHour = hourCap > 0 ? tradesOpenedSince(a, Date.now() - 3_600_000) : 0;
      if (rep) {
        rep.at = Date.now();
        rep.candidates += candidates.length;
        rep.heldOpen = a.open.filter((p) => inScope(p.ref)).length;
      }
      const skip = (t: LabOpenTrade, why: string, wait = false) => {
        if (rep) (wait ? rep.waits : rep.skipped).push({ pair: t.pair, strategy: t.strategy, tf: t.tf ?? tfOfRef(t.ref), side: t.side, why });
      };
      // v27.24: a losing streak slows the bot down (half size from 3 in a row, a pause after 4)
      const streak = BOT.streak.on ? lossStreak(a.closed) : { n: 0, lastAt: null };
      const pausedUntil = streak.n >= BOT.streak.pauseAt && streak.lastAt !== null ? streak.lastAt + BOT.streak.pauseHours * 3_600_000 : 0;
      const streakF = streak.n >= BOT.streak.halveAt ? BOT.streak.factor : 1;
      for (const t of candidates) {
        const sk = stratKey(t.ref);
        if (dayCap > 0 && openedToday >= dayCap) {
          note(`daycap:${tradingDayStart(Date.now())}`, `daily limit reached: ${openedToday} trades opened today (max ${dayCap}) — no new trades until 22:00 UTC`);
          skip(t, `daily limit reached: ${openedToday} of ${dayCap} trades opened today`, true);
          continue;
        }
        if (hourCap > 0 && openedHour >= hourCap) {
          skip(t, `hourly limit reached: ${openedHour} of ${hourCap} trades opened in the last hour (spreads the day's trades out)`, true);
          continue;
        }
        if (Date.now() < pausedUntil) {
          const w = `${streak.n} losses in a row — no new trades until ${new Date(pausedUntil).toISOString().slice(11, 16)} UTC`;
          note(`streak:${pausedUntil}`, `waiting: ${w}`);
          skip(t, w, true);
          continue;
        }
        const tf = t.tf ?? tfOfRef(t.ref);
        // v27.23 (owner: "any loss that's not a bug — analyse it and make sure it doesn't happen again"; two strategies bought
        // LINK on the same candle and both hit their stops): one bet per market and direction at a time
        if (BOT.onePerMarketSide && [...a.open, ...(a.orders ?? [])].some((p) => p.pair === t.pair && p.side === t.side)) {
          note(`${t.ref}:dup`, `skipped ${t.pair} (${t.strategy}): already in a ${t.side === 1 ? 'buy' : 'sell'} on ${t.pair}`);
          skip(t, `already in a ${t.side === 1 ? 'buy' : 'sell'} trade on this market (one bet per market and direction)`);
          continue;
        }
        const sideCap = BOT.maxSameSide[acct] ?? 0;
        const sameSide = sideCap > 0 ? [...a.open, ...(a.orders ?? [])].filter((p) => p.side === t.side).length : 0;
        if (sideCap > 0 && sameSide >= sideCap) {
          note(`side:${t.side}:${sameSide}`, `holding off new ${t.side === 1 ? 'buys' : 'sells'}: already ${sameSide} open the same way (max ${sideCap} — coins move together)`);
          skip(t, `already ${sameSide} ${t.side === 1 ? 'buy' : 'sell'} trades open across the coins (max ${sideCap} the same way — coins move together)`, true);
          continue;
        }
        const cool = reentryWait(a.closed, t.strategy, tf, t.pair, Date.now());
        if (cool > 0) {
          note(`${t.ref}:cool`, `waiting on ${t.pair} (${t.strategy}): it just closed a trade here — cooling off ${cool} min`);
          skip(t, `just closed a trade here — cooling off for ${cool} min (${BOT.reentryCooldownBars} ${tf} candles)`, true);
          continue;
        }
        const brakeCfg = BOT.liveBrake[acct];
        const brake = brakeCfg ? liveBrake(a.ledger?.[`${t.strategy}:${tf}`], Date.now(), brakeCfg) : null;
        if (brake?.paused) {
          const until = new Date(brake.until!).toISOString().slice(5, 16).replace('T', ' ');
          note(`${t.strategy}:${tf}:brake`, `paused ${t.strategy} ${tf}: its last ${brake.n} live trades made ${brake.r}R — not sure enough, back after ${until} UTC`);
          skip(t, `its own live trades lost (${brake.n} trades, ${brake.r}R) — paused until ${until} UTC`, true);
          continue;
        }
        if ((perStrategy.get(sk) ?? 0) >= L.maxPerStrategy) {
          note(`${t.ref}:strat`, `skipped ${t.pair} (${t.strategy}): it already has ${L.maxPerStrategy} trades open`);
          skip(t, `its strategy already has ${L.maxPerStrategy} trades open`);
          continue;
        }
        const tfCap = L.maxOpenByTf[tf];
        if (tfCap !== undefined && (perTf.get(tf) ?? 0) >= tfCap) {
          note(`${t.ref}:tf`, `skipped ${t.pair} (${t.strategy}): already ${tfCap} ${tf} trades open`);
          skip(t, `already ${tfCap} ${tf} trades open`);
          continue;
        }
        if (t.dataWait) {
          note(`${t.ref}:data`, `waiting on ${t.pair} (${t.strategy}): ${t.dataWait}`);
          skip(t, t.dataWait, true);
          continue;
        }
        if (t.soloWait && !t.desk) {
          note(`${t.ref}:solo`, `waiting on ${t.pair} (${t.strategy}): ${t.soloWait}`);
          skip(t, t.soloWait, true);
          continue;
        }
        if (t.agree && t.agree.need > 0 && t.agree.n < Math.min(t.agree.need, t.agree.of) && !t.desk) {
          // v20.1 strict mode: not enough of the market checks stand behind it → wait for a better-backed setup
          const w = `only ${t.agree.n} of ${t.agree.of} market checks agree (needs ${Math.min(t.agree.need, t.agree.of)}: strength, bigger charts, mood)`;
          note(`${t.ref}:agree`, `waiting on ${t.pair} (${t.strategy}): ${w}`);
          skip(t, w, true);
          continue;
        }
        if (t.marketRec && !t.marketRec.ok && !t.desk) {
          // v20.4 / v24.1: the strategy's tested record on this market is a losing one → it does not trade it here
          const w = `losing record on this market (${t.marketRec.n} tested trades here, profit factor ${t.marketRec.pf ?? '—'}, ${t.marketRec.totalR}R)`;
          note(`${t.ref}:market`, `waiting on ${t.pair} (${t.strategy}): ${w}`);
          skip(t, w, true);
          continue;
        }
        if (t.judge && !t.judge.ok && t.judge.missing && !t.desk) {
          // v17: the judge can't score it right now (a reading it learned from is missing) — wait, don't trade blind
          note(`${t.ref}:judge`, `waiting on ${t.pair} (${t.strategy}): the signal judge is missing ${t.judge.missing}`);
          skip(t, `the signal judge can't score it: missing ${t.judge.missing}`, true);
          continue;
        }
        if (t.judge && !t.judge.ok && !t.desk) {
          note(`${t.ref}:judge`, `skipped ${t.pair} (${t.strategy}): the signal judge gives it a ${Math.round(t.judge.p * 100)}% chance (needs ${Math.round((t.judge.need ?? 0) * 100)}%)`);
          skip(t, `the signal judge gives it ${Math.round(t.judge.p * 100)}% (needs ${Math.round((t.judge.need ?? 0) * 100)}%)`);
          continue;
        }
        const qs = q[t.pair];
        const ck = clockFor(t.pair, Date.now()); // v22: a coin market has no weekly close, rollover or Monday warm-up
        const why = ck.noNewTrades
          ? ck.open
            ? 'weekly close is near'
            : 'market closed'
          : ck.rollover
            ? 'daily rollover (20:45–23:15 UTC): spreads are wide'
            : ck.sinceOpenMin < 120
              ? 'the week just opened: spreads are still wide'
              : // v26.4: a news strategy trades the shock — the price-shock pause is for everyone else
                blockFor(t.pair, t.strategy) ?? (!tradesNews(t.strategy) && qs && priceShock(qs.bars, atr1h[t.pair] ?? 0) ? 'price shock: unusually big move in the last 15 min' : null);
        if (why) {
          note(`${t.pair}:${why}`, `waited on ${t.pair} (${t.strategy}): ${why}`);
          skip(t, why, true);
          continue;
        }
        if (a.open.length >= L.maxOpen) {
          skip(t, `all ${L.maxOpen} slots are full`, true);
          continue;
        }
        const qq = q[t.pair];
        if (!qq || qq.tradeable === false || qq.stale) {
          skip(t, qq?.stale ? 'only an old price right now (feed hiccup)' : 'no live price', true);
          continue;
        }
        const entryNow = t.side === 1 ? qq.ask : qq.bid;
        // v18.4: a tested limit / pullback entry rests at its limit unless the price is already there (then it is a
        // market fill at a price as good as the limit, exactly what the backtest assumed)
        const resting = t.order && Date.now() < t.order.until && (t.side === 1 ? entryNow > t.order.limit : entryNow < t.order.limit) ? t.order : null;
        const entry = resting ? resting.limit : entryNow;
        const dist = (entry - t.stop) * t.side;
        if (!(dist > 0)) {
          skip(t, 'price already past its stop');
          continue;
        }
        // v17: the lab's trade is graded from its own fill — a price that already ran past the target, or far from that
        // fill, is a different (untested) trade
        if (t.target !== null && (t.side === 1 ? entry >= t.target : entry <= t.target)) {
          skip(t, 'price already past its target');
          continue;
        }
        if (t.entry !== undefined && Math.abs(t.entry - t.stop) > 0) {
          const drift = ((entry - t.entry) * t.side) / Math.abs(t.entry - t.stop);
          if (drift > BOT.maxEntryDriftR) {
            skip(t, `price moved ${drift.toFixed(2)}R its way since the signal (chasing; ≤ ${BOT.maxEntryDriftR}R)`);
            continue;
          }
        }
        const v = view(a, mids);
        // v15.2: a proven 'sure' / 'very sure' entry risks 1.5× / 2× (at most 2% of the account) at 50× / 100× leverage
        const conv = t.conviction && t.conviction.mult > 1 ? t.conviction : null;
        // v16: a proven sniper setup (enough independent checks agree) risks the sniper size — one at a time, never
        // less than the mode's own size, still smaller after a drawdown
        const snipe = t.sniper?.on && !a.open.some((p) => p.sniper) ? t.sniper : null;
        // v27.26: an all-in strategy risks its own % (minus what other all-in trades already risk), past every cap
        const allInPct = t.allIn || BOT.allIn[acct]?.[`${t.strategy}:${tf}`]; // v27.27: set by the lab on proven trades
        const allInLeft = allInPct ? allInPct - a.open.filter((p) => p.allIn && p.tf !== 'signal').reduce((s, p) => s + (p.riskPct ?? 0), 0) : 0;
        if (allInPct && allInLeft < 1) {
          skip(t, `already ${allInPct}% of the account riding on an all-in trade`, true);
          continue;
        }
        // v15.6: the risk mode scales the base risk, leverage and every cap together
        const lev = allInPct ? maxLeverageFor(t.pair) : Math.min(maxLeverageFor(t.pair), snipe ? Math.max(SNIPER.leverage, L.leverage) : Math.max(conv?.lev ?? 0, L.leverage)); // v22: coins capped
        let riskPct = allInPct ? allInLeft : snipe ? Math.max(SNIPER.riskPct, L.riskPct) * ddF : clampRisk(L.riskPct, L.riskPct * (t.sizeF ?? 1) * ddF * (conv?.mult ?? 1), conv ? L.convMaxRiskPct / L.riskPct : undefined);
        if (streakF < 1 && !allInPct) riskPct = Math.round(riskPct * streakF * 100) / 100; // v27.24: losing streak → half size
        const exp = currencyExposure(a.open, mids, v.equityUsd);
        const over = snipe || allInPct ? null : exposureBlock(exp, t.pair, t.side, riskPct, L.ccyCapPct);
        if (over) {
          note(`${t.ref}:ccy`, `skipped ${t.pair} (${t.strategy}): already ${Math.abs(exp[over] ?? 0).toFixed(1)}% of the account riding on ${over}`);
          skip(t, `already ${Math.abs(exp[over] ?? 0).toFixed(1)}% of the account riding on ${over}`);
          continue;
        }
        // v17: trades that move together count as one bet — smaller, or skipped, when the combined risk is full. Checked
        // after the currency cap at full size (the honest test's order), only once that test showed the cap cuts the
        // drawdown; sniper trades stay outside it, as with the currency cap
        let heatNote = '';
        if (opts.heat?.active && !snipe && !allInPct && v.equityUsd > 0) {
          // each open trade counts with the risk it opened with (as in the honest test), not its trailed stop
          const pos = a.open.filter((p) => !p.sniper).map((p) => ({ pair: p.pair, side: p.side, riskPct: p.riskPct ?? (positionRiskUsd(p, mids) / v.equityUsd) * 100 }));
          const room = maxRiskUnder(pos, { pair: t.pair, side: t.side }, L.heatCapPct, opts.heat.book, opts.heat.m);
          if (room < riskPct) {
            const tc = topCorrelated(pos, { pair: t.pair, side: t.side }, opts.heat.book, opts.heat.m);
            const withWhat = tc ? `it moves with your open ${tc.pair} trade (ρ ${tc.rho})` : 'open trades that move together';
            if (room < HEAT.minScale * riskPct) {
              note(`${t.ref}:heat`, `skipped ${t.pair} (${t.strategy}): correlated risk is full — ${withWhat}`);
              skip(t, `correlated risk is full — ${withWhat}`);
              continue;
            }
            heatNote = ` (smaller: ${withWhat})`;
            riskPct = room;
          }
        }
        // v27.79: size so the tested stop loses at most the $ cap — the cap never has to pull the stop in
        if (BOT.sizeToCap[acct] && a.maxLossUsd && !allInPct && v.equityUsd > 0) {
          const capPct = Math.floor(((a.maxLossUsd * BOT.sizeToCapHeadroom) / v.equityUsd) * 10_000) / 100;
          if (riskPct > capPct) riskPct = capPct;
        }
        const notional = (v.equityUsd * riskPct) / 100 / (dist / entry);
        let margin = notional / lev;
        margin = Math.min(margin, v.freeMarginUsd * (allInPct ? BOT.allInMarginShare : SIZING.marginShare));
        if (margin < 1) {
          skip(t, 'not enough free margin');
          continue;
        }
        const actual = Math.round(((margin * lev * (dist / entry)) / v.equityUsd) * 10_000) / 100;
        if (resting) {
          const order: RestingOrder = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pair: t.pair, side: t.side, limit: resting.limit, kind: resting.kind, placedAt: Date.now(), expiresAt: resting.until, ref: t.ref, strategy: t.strategy, stop: t.stop, target: t.target, marginUsd: Math.round(margin * 100) / 100, leverage: lev, riskPct: actual, ...planOf(t), tf, ...(t.conviction ? { conviction: t.conviction } : {}), ...(snipe ? { sniper: { votes: snipe.votes, of: snipe.of } } : {}) };
          a.orders = [...(a.orders ?? []), order];
          openedToday++;
          openedHour++;
          perStrategy.set(sk, (perStrategy.get(sk) ?? 0) + 1);
          perTf.set(tf, (perTf.get(tf) ?? 0) + 1);
          if (rep) rep.opened++;
          events.push(`placed a ${resting.kind === 'pullback' ? 'pullback' : 'limit'} order to ${t.side === 1 ? 'buy' : 'sell'} ${t.pair} (${t.strategy}, ${tf}) at ${resting.limit.toPrecision(6)}, good until ${new Date(resting.until).toISOString().slice(11, 16)} UTC, risking ${actual}%${heatNote}`);
          continue;
        }
        // v27.45: the excursion study's $ loss cap for this strategy × chart (only once it has enough trades; never all-in)
        const slc = this.slCaps[acct];
        const capSl = !allInPct && slc?.active && a.maxLossUsd ? slc.byKey[`${t.strategy}:${tf}`] ?? slc.def : undefined;
        const capFor = capSl !== undefined && BOT.capFloorAccts[acct] && a.maxLossUsd && capSl <= a.maxLossUsd ? undefined : capSl;
        const r = await this.openIn(a, { pair: t.pair, side: t.side, marginUsd: margin, leverage: lev, stop: t.stop, target: t.target, strategy: t.strategy, ref: t.ref, riskPct: actual, ...planOf(t), tf, desk: !!t.desk, ...(allInPct ? { allIn: true } : {}), ...(capFor ? { maxLossUsd: capFor } : {}), ...(t.conviction ? { conviction: t.conviction } : {}), ...(snipe ? { sniper: { votes: snipe.votes, of: snipe.of } } : {}), maxQuoteAgeMs: BOT.quoteAgeMsByTf[tf] ?? 10 * 60_000, feedDelayOk: tf === '1h' || tf === '4h' });
        const sure = allInPct ? ` — ALL-IN (${t.strategy} ${tf}, a proven strategy): risking ${actual}% at ${lev}× on its tested stop` : t.desk ? ` — DESK learning trade: ${t.desk.why}` : snipe ? ` — SNIPER: ${snipe.votes} of ${snipe.of} checks agree, risking ${actual}% at ${lev}×` : conv ? ` — ${conv.tier === 'verySure' ? 'very sure' : 'sure'} (${conv.conf} of ${conv.of} checks agree): bigger size at ${lev}×` : '';
        events.push(r.ok ? `opened ${t.side === 1 ? 'long' : 'short'} ${t.pair} (${t.strategy}, ${tf}), risking ${actual}% of the account${sure}${ddF < 1 ? ` (smaller: ${ddPct.toFixed(0)}% under its peak)` : ''}${heatNote}${capFor && capFor !== a.maxLossUsd ? `, loss cap $${capFor} (from how its past trades dipped)` : ''}` : `skipped ${t.pair}: ${r.error}`);
        if (r.ok) {
          openedToday++;
          openedHour++;
          perStrategy.set(sk, (perStrategy.get(sk) ?? 0) + 1);
          perTf.set(tf, (perTf.get(tf) ?? 0) + 1);
          if (rep) rep.opened++;
        } else skip(t, r.error ?? 'could not open');
      }
      await this.save(a, acct);
      if (events.length) log.info({ events }, 'forex bot account');
      return events;
    });
  }

  /** v15.3: refs of the bot's open trades (no prices needed). */
  /** v27.23: the account as stored (read-only — the loss review reads its closed / open trades) */
  async rawAccount(acct: AcctId = 'bot'): Promise<PracticeAccount> {
    return this.load(acct);
  }

  async heldRefs(acct: AcctId = 'bot'): Promise<string[]> {
    const a = await this.load(acct);
    return a.open.map((p) => p.ref).filter((r): r is string => !!r);
  }

  /** v17: every finished bot trade in R (newest last). */
  async botLedger(acct: AcctId = 'bot'): Promise<BotLedgerRow[]> {
    return ledgerRows(await this.load(acct));
  }

  /** Results of the bot account per strategy and chart (`ema_cross:1h`), to drop what loses in real time. */
  async botResults(now = Date.now(), acct: AcctId = 'bot'): Promise<Record<string, { n: number; pnlUsd: number }>> {
    return botRecordOf(await this.load(acct), now);
  }

  async close(id: string | 'all', acct: AcctId = 'me'): Promise<{ ok: boolean; error?: string }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const targets = id === 'all' ? [...a.open] : a.open.filter((p) => p.id === id);
      if (!targets.length) return { ok: false, error: 'no such position' };
      const q = await this.quotes(this.neededIds(a), 5_000);
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      let pending = 0;
      for (const p of targets) {
        const qq = q[p.pair];
        // v17: no price → never a made-up close at the entry price: it closes at the first price that arrives
        if (!qq || qq.stale) {
          p.closePending = { reason: 'manual', at: Date.now() };
          pending++;
          continue;
        }
        closePos(a, p, p.side === 1 ? qq.bid : qq.ask, mids, 'manual', Date.now());
      }
      await this.save(a, acct);
      return pending ? { ok: true, error: `${pending} position${pending > 1 ? 's' : ''} will close at the first price (no live price right now)` } : { ok: true };
    });
  }

  /** v27.46: open a copy of a Discord signal (discord.ts). Safety stop from the message or `stopPct`; sized so that stop
   * loses `riskPct` of the account (v27.57: shared by all open copies, past the $ loss cap); no target, he posts the exit. */
  async copyOpen(r: Parameters<CopyBook['copyOpen']>[0], acct: 'bot' | 'cbot'): ReturnType<CopyBook['copyOpen']> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const inst = instrument(r.pair);
      if (!inst) return { ok: false, error: 'unknown market' };
      if (a.open.some((p) => p.ref === r.ref)) return { ok: false, error: 'already copied' };
      const q = await this.quotes(this.neededIds(a, [inst.id]), 10_000);
      const quote = q[inst.id];
      if (!quote || quote.stale) return { ok: false, error: 'no live price right now' };
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      const entry = r.side === 1 ? quote.ask : quote.bid;
      // v27.51: a trade at his posted levels brings its own stop (past the absorbing candle) and target (his next level)
      const stop = r.stop ?? copyStop(r.side, entry, r.stopNamed);
      if (r.side === 1 ? stop >= entry : stop <= entry) return { ok: false, error: `the price ${entry} is already past the stop ${stop}` };
      const target = r.target != null && (r.side === 1 ? r.target > entry : r.target < entry) ? r.target : null;
      const stopDist = Math.abs(entry - stop);
      if (r.hisPx && Math.abs(entry - r.hisPx) > DISCORD_COPY.maxMismatchStops * stopDist) return { ok: false, error: `our price ${entry} is far from his ${r.hisPx} — wrong market?` };
      const v = view(a, mids, { [inst.id]: (quote.ask - quote.bid) / 2 });
      const perUnit = unitsFor(inst, 1, mids);
      const usdPerUnitMove = Math.abs(pnlUsd({ pair: inst.id, side: 1, units: 1, entry }, entry + 1, mids));
      const lev = Math.max(1, Math.min(Math.round(r.leverage), MAX_LEVERAGE, maxLeverageFor(inst.id)));
      // v27.57: his calls are all-in like a proven cell — `riskPct` (20) is shared by every open copy, the $ loss cap doesn't apply
      const riding = a.open.filter((p) => p.tf === 'signal').reduce((s, p) => s + (p.riskPct ?? 0), 0);
      const left = Math.round((r.riskPct - riding) * 100) / 100;
      if (left < 0.5) return { ok: false, error: `already ${Math.round(riding * 10) / 10}% of the account riding on his calls (max ${r.riskPct}%)` };
      const riskUsd = (v.equityUsd * left) / 100;
      // v27.72: the venue fee must leave the trade a chance (≤ 25% of its stop) and stay small next to the account (≤ 1%)
      const feePx = feePxOf(inst, entry);
      if (feePx > DISCORD_COPY.maxFeeShare * stopDist) return { ok: false, error: `the round-trip fee (${+feePx.toPrecision(3)} a unit) is ${Math.round((feePx / stopDist) * 100)}% of its ${+stopDist.toPrecision(3)} stop — can't win after fees` };
      const size = copySize({ riskUsd, stopDist, usdPerUnitMove, notionalPerUnit: perUnit ? 1 / perUnit : 0, leverage: lev, freeMarginUsd: v.freeMarginUsd, marginShare: DISCORD_COPY.marginShare });
      const feeRate = 2 * feePctPerSide(inst) / 100;
      const maxFee = (v.equityUsd * DISCORD_COPY.maxFeePctOfEquity) / 100;
      if (feeRate > 0 && size.marginUsd * lev * feeRate > maxFee) {
        const k = maxFee / (size.marginUsd * lev * feeRate);
        size.marginUsd = Math.floor(size.marginUsd * k * 100) / 100;
        size.riskUsd = Math.round(size.riskUsd * k * 100) / 100;
      }
      if (!(size.marginUsd > 0)) return { ok: false, error: `no room (free margin $${v.freeMarginUsd})` };
      const riskPct = v.equityUsd > 0 ? Math.round((size.riskUsd / v.equityUsd) * 10_000) / 100 : 0;
      const res = await this.openIn(a, { pair: inst.id, side: r.side, marginUsd: size.marginUsd, leverage: lev, stop, target, strategy: r.strategy, ref: r.ref, riskPct, tf: 'signal', allIn: true, maxQuoteAgeMs: 2 * 60_000, feedDelayOk: true, noLock: !r.profitLock, ...(r.copyLock === 'tight' ? { copyLock: 'tight' as const } : {}) });
      if (!res.ok) return res;
      await this.save(a, acct);
      const p = a.open[a.open.length - 1]!;
      return { ok: true, entry: p.entry, stop: Math.round(stop * 1e5) / 1e5, riskUsd: size.riskUsd, marginUsd: size.marginUsd };
    });
  }

  /** v27.46: close the open copies of one strategy (`side` 1 = longs, −1 = shorts, 0 = both) at the market — reason
   * 'signal'; with no live price they close at the first price that arrives. */
  async copyClose(m: Parameters<CopyBook['copyClose']>[0], acct: 'bot' | 'cbot'): ReturnType<CopyBook['copyClose']> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const targets = a.open.filter((p) => p.strategy === m.strategy && (!m.pair || p.pair === m.pair) && (!m.side || p.side === m.side) && !p.closePending);
      if (!targets.length) return { ok: true, closed: [], pending: 0 };
      const q = await this.quotes(this.neededIds(a), 5_000);
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      const closed: string[] = [];
      let pending = 0;
      for (const p of targets) {
        const qq = q[p.pair];
        if (!qq || qq.stale) {
          p.closePending = { reason: 'signal', at: Date.now() };
          pending++;
        } else {
          const pl = closePos(a, p, p.side === 1 ? qq.bid : qq.ask, mids, 'signal', Date.now());
          closed.push(`${p.side === 1 ? 'long' : 'short'} ${p.pair} ${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(2)}`);
          continue;
        }
        closed.push(`${p.side === 1 ? 'long' : 'short'} ${p.pair}`);
      }
      await this.save(a, acct);
      return { ok: true, closed, pending };
    });
  }

  /** v27.46: "SL to BE" — the open copies' stop to their entry (only ever tighter). */
  async copyBreakeven(m: Parameters<CopyBook['copyBreakeven']>[0], acct: 'bot' | 'cbot'): ReturnType<CopyBook['copyBreakeven']> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const moved: string[] = [];
      for (const p of a.open) {
        if (p.strategy !== m.strategy || (m.pair && p.pair !== m.pair)) continue;
        if (p.stop !== null && (p.side === 1 ? p.stop >= p.entry : p.stop <= p.entry)) continue;
        p.stop = p.entry;
        p.stopMovedT = null;
        moved.push(`${p.side === 1 ? 'long' : 'short'} ${p.pair}`);
      }
      if (moved.length) await this.save(a, acct);
      return { ok: true, moved };
    });
  }

  async edit(id: string, stop: number | null, target: number | null, acct: AcctId = 'me'): Promise<{ ok: boolean; error?: string }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const p = a.open.find((x) => x.id === id);
      if (!p) return { ok: false, error: 'no such position' };
      p.stop = stop;
      p.target = target;
      // v17.11: a new target / stop → the profit lock is worked out again (unless it already armed)
      if (!p.locked) p.lock = undefined;
      p.stopMovedT = null;
      await this.save(a, acct);
      return { ok: true };
    });
  }

  /** Candles for the chart: OANDA when connected, else Yahoo (4h built from 1h). */
  async candles(id: string, g: Granularity, count = 300): Promise<{ source: 'oanda' | 'yahoo'; bars: Array<Bar & { v?: number }> }> {
    const inst = instrument(id);
    if (!inst) return { source: 'yahoo', bars: [] };
    const s = await loadOanda();
    if (oandaReady(s)) {
      try {
        // v27.47: a futures market's CFD / spot candles moved onto the futures price; no gap measured yet → Yahoo below
        const b = !oandaCovers(id) ? null : needsBasis(id) ? this.basisFor(id, 'oanda', Date.now(), s) : 0;
        if (b !== null) return { source: 'oanda', bars: (await oandaCandles(s, id, g, count)).map((x) => ({ ...x, o: x.o + b, h: x.h + b, l: x.l + b, c: x.c + b })) };
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'oanda candles failed, using yahoo');
      }
    }
    const map: Record<Granularity, [string, string]> = { S5: ['1m', '1d'], M1: ['1m', '1d'], M5: ['5m', '5d'], M15: ['15m', '5d'], H1: ['60m', '1mo'], H4: ['60m', '3mo'], D: ['1d', '2y'] };
    const [interval, range] = map[g];
    for (const h of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const res = await fetch(`https://${h}/v8/finance/chart/${encodeURIComponent(inst.yahoo)}?interval=${interval}&range=${range}`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const j = (await res.json()) as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> } }> } };
        const r0 = j.chart?.result?.[0];
        const qq = r0?.indicators?.quote?.[0];
        let bars: Array<Bar & { v?: number }> = [];
        (r0?.timestamp ?? []).forEach((ts, k) => {
          const o = qq?.open?.[k];
          const hh = qq?.high?.[k];
          const l = qq?.low?.[k];
          const c = qq?.close?.[k];
          if (o != null && hh != null && l != null && c != null && c > 0) bars.push({ t: ts * 1000, o, h: hh, l, c, v: qq?.volume?.[k] ?? 0 });
        });
        if (g === 'H4') {
          const out: Array<Bar & { v?: number }> = [];
          for (const b of bars) {
            const k = Math.floor(b.t / 14_400_000) * 14_400_000;
            const last = out[out.length - 1];
            if (last && last.t === k) {
              last.h = Math.max(last.h, b.h);
              last.l = Math.min(last.l, b.l);
              last.c = b.c;
            } else out.push({ ...b, t: k });
          }
          bars = out;
        }
        return { source: 'yahoo', bars: (await this.liveChartTail(id, g, bars)).slice(-count) };
      } catch {
        // next host
      }
    }
    return { source: 'yahoo', bars: [] };
  }

  /** v27.56: an index / metal chart from Yahoo (~10 min late) gets its newest candles from Hyperliquid, moved onto the
   * futures price by the measured gap (`liveTail`); no live market / no gap yet / any error → Yahoo's candles as they are. */
  private async liveChartTail(id: string, g: Granularity, bars: Array<Bar & { v?: number }>): Promise<Array<Bar & { v?: number }>> {
    const iv = ({ M1: '1m', M5: '5m', M15: '15m', H1: '1h', H4: '4h' } as const)[g as 'M1' | 'M5' | 'M15' | 'H1' | 'H4'];
    if (!iv || !needsBasis(id) || !bars.length) return bars;
    const now = Date.now();
    const gap = this.basisFor(id, 'hl', now);
    if (gap === null) return bars;
    const span = ({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 } as const)[iv] * 1000;
    try {
      const live = await this.hlBars(id, iv, bars[bars.length - 1]!.t - 3 * span, now);
      return liveTail(bars, live, gap, now, (t) => !clockFor(id, t).open);
    } catch {
      return bars;
    }
  }

  async reset(startUsd: number, acct: AcctId = 'me'): Promise<void> {
    await this.serial(async () => {
      const fresh = newAccount(Math.min(1_000_000, Math.max(10, startUsd)));
      // the bot keeps its risk mode across a reset
      const old = await this.load(acct).catch(() => null);
      if (acct !== 'me' && old?.riskMode) fresh.riskMode = old.riskMode;
      // v17.11: the profit-lock switch survives a reset too
      if (old?.profitLock === false) fresh.profitLock = false;
      // v17.8: the P&L log starts again with the account
      await this.save(fresh, acct, { clearLog: true });
    });
  }

  /** v18.8: strike one chart's trades from an account (balance restored, P&L log rewritten). Returns a log line. */
  async undoChart(acct: AcctId, tf: string): Promise<string> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = undoChart(a, tf);
      if (this.pnlLogs()) {
        const key = pnlKey(acct);
        const raw = await this.redis.lrange(key, 0, -1);
        const keep = raw.filter((x) => {
          const row = parsePnlRow(x);
          return row !== null && row.tf !== tf;
        });
        const m = this.redis.multi().del(key);
        if (keep.length) m.rpush(key, ...keep);
        await m.exec();
        this.pnlReady.add(acct);
        this.pnlDirty(acct);
      }
      await this.save(a, acct);
      return `${tf} chart struck from the ${acct} account: ${r.closed} closed trade${r.closed === 1 ? '' : 's'} (${r.usd >= 0 ? '−' : '+'}$${Math.abs(r.usd).toFixed(2)} taken back out), ${r.open} open, ${r.orders} resting order${r.orders === 1 ? '' : 's'} removed — balance now $${a.balanceUsd.toFixed(2)}`;
    });
  }

  /** v27.21: add correction rows (reason 'adjust') to an account's P&L log — money moved between days; the balance is
   * not touched (the rows must sum to 0 or match a balance change made elsewhere). */
  async bookAdjust(acct: AcctId, rows: PnlRow[]): Promise<void> {
    if (!this.pnlLogs() || !rows.length) return;
    await this.serial(async () => {
      await this.seedPnl(acct);
      await this.redis.rpush(pnlKey(acct), ...rows.map((r) => JSON.stringify(r)));
      this.pnlDirty(acct);
    });
  }

  /** v27.21: strike chosen closed trades from an account (+ the durable P&L log) as if they never happened. */
  async undoClosed(acct: AcctId, pick: (c: ClosedPractice) => boolean, label: string): Promise<string> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = undoClosed(a, pick);
      if (this.pnlLogs() && r.ids.length) {
        const key = pnlKey(acct);
        const raw = await this.redis.lrange(key, 0, -1);
        const gone = new Set(r.ids);
        const keep = raw.filter((x) => {
          const row = parsePnlRow(x);
          return row !== null && !gone.has(row.id);
        });
        const m = this.redis.multi().del(key);
        if (keep.length) m.rpush(key, ...keep);
        await m.exec();
        this.pnlReady.add(acct);
        this.pnlDirty(acct);
      }
      await this.save(a, acct);
      return `${label}: ${r.ids.length} closed trade${r.ids.length === 1 ? '' : 's'} struck (${r.usd < 0 ? '+' : '−'}$${Math.abs(r.usd).toFixed(2)} back) — balance now $${a.balanceUsd.toFixed(2)}`;
    });
  }

  async refundIndexFees(acct: AcctId, oldPct: number, newPct: number): Promise<string> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = refundIndexFees(a, oldPct, newPct);
      if (this.pnlLogs() && r.rows.length) {
        const key = pnlKey(acct);
        const raw = await this.redis.lrange(key, 0, -1);
        const by = new Map(r.rows.map((x) => [x.id, x.usd]));
        const next = raw.map((x) => {
          const row = parsePnlRow(x);
          return row && by.has(row.id) ? JSON.stringify({ ...row, usd: by.get(row.id) }) : x;
        });
        const m = this.redis.multi().del(key);
        if (next.length) m.rpush(key, ...next);
        await m.exec();
        this.pnlReady.add(acct);
        this.pnlDirty(acct);
      }
      await this.save(a, acct);
      return `index fees corrected to the real rate (${newPct}% a side, was ${oldPct}%): ${r.ids.length} closed trade${r.ids.length === 1 ? '' : 's'}, +$${r.usd.toFixed(2)} back — balance now $${a.balanceUsd.toFixed(2)}`;
    });
  }

  /** v20.1: strike every open trade (+ its parts, orders, weekend pauses) from an account as if it never happened. */
  async undoOpen(acct: AcctId): Promise<string> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = undoOpen(a);
      if (this.pnlLogs() && r.ids.length) {
        const key = pnlKey(acct);
        const raw = await this.redis.lrange(key, 0, -1);
        const keep = raw.filter((x) => {
          const row = parsePnlRow(x);
          return row !== null && !r.ids.some((id) => row.id === id || row.id.startsWith(`${id}-part`));
        });
        const m = this.redis.multi().del(key);
        if (keep.length) m.rpush(key, ...keep);
        await m.exec();
        this.pnlReady.add(acct);
        this.pnlDirty(acct);
      }
      await this.save(a, acct);
      return `open trades struck from the ${acct} account as if they never happened: ${r.open} position${r.open === 1 ? '' : 's'}, ${r.parts} part${r.parts === 1 ? '' : 's'} (${r.usd >= 0 ? '−' : '+'}$${Math.abs(r.usd).toFixed(2)} taken back out), ${r.orders} resting order${r.orders === 1 ? '' : 's'}, ${r.paused} weekend pause${r.paused === 1 ? '' : 's'} — balance now $${a.balanceUsd.toFixed(2)}`;
    });
  }

  /** v27.22: strike chosen open positions (+ their P&L-log parts) as if they never happened; the signal is never re-opened. */
  async undoPositions(acct: AcctId, pick: (p: PracticePosition) => boolean, label: string): Promise<string> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = undoPositions(a, pick);
      if (this.pnlLogs() && r.ids.length) {
        const key = pnlKey(acct);
        const raw = await this.redis.lrange(key, 0, -1);
        const keep = raw.filter((x) => {
          const row = parsePnlRow(x);
          return row !== null && !r.ids.some((id) => row.id === id || row.id.startsWith(`${id}-part`));
        });
        const m = this.redis.multi().del(key);
        if (keep.length) m.rpush(key, ...keep);
        await m.exec();
        this.pnlReady.add(acct);
        this.pnlDirty(acct);
      }
      await this.save(a, acct);
      return `${label}: ${r.ids.length} open trade${r.ids.length === 1 ? '' : 's'} struck${r.usd ? ` (${r.usd >= 0 ? '−' : '+'}$${Math.abs(r.usd).toFixed(2)} booked rolls taken back)` : ''} — balance now $${a.balanceUsd.toFixed(2)}`;
    });
  }

  /** v27.59 (owner: "re-enter his trade, it sold, I didn't want that"): open the newest closed Discord copy again at the
   * market — same market, side and strategy, its ORIGINAL stop price (the stop it opened with, not one the cap / lock
   * moved), no target, `riskPct` of the account; refused when the price is already past that stop. A new ref, so the
   * close stays in the record as it happened. */
  async reenterCopy(acct: 'bot' | 'cbot', riskPct: number, pick: (c: ClosedPractice) => boolean = () => true): Promise<string> {
    const a = await this.serial(() => this.load(acct));
    const last = [...a.closed].filter((c) => c.tf === 'signal' && c.reason !== 'partial' && pick(c)).sort((x, y) => y.closedAt - x.closedAt)[0];
    if (!last) return 'no closed Kojiro copy to re-enter';
    if (a.open.some((p) => p.tf === 'signal' && p.pair === last.pair && p.side === last.side)) return `already back in a ${last.side === 1 ? 'long' : 'short'} ${last.pair} copy`;
    const per = Math.abs(pnlUsd({ pair: last.pair, side: 1, units: 1, entry: last.entry }, last.entry + 1, { [last.pair]: last.entry }));
    const d0 = last.riskUsd0 && last.units > 0 && per > 0 ? last.riskUsd0 / (last.units * per) : last.stop !== null ? Math.abs(last.entry - last.stop) : 0;
    if (!(d0 > 0)) return `${last.pair}: no original stop to re-enter with`;
    const stop = last.entry - last.side * d0;
    const n = a.closed.filter((c) => c.ref?.startsWith(`${last.ref}:re`)).length + a.open.filter((p) => p.ref?.startsWith(`${last.ref}:re`)).length;
    const r = await this.copyOpen({ pair: last.pair, side: last.side, stopNamed: null, hisPx: null, strategy: last.strategy ?? 'discord_kojiro', ref: `${last.ref}:re${n + 1}`, riskPct, leverage: DISCORD_COPY.leverage, profitLock: DISCORD_COPY.profitLock, stop, target: null }, acct);
    const what = `${last.side === 1 ? 'long' : 'short'} ${last.pair} (closed ${new Date(last.closedAt).toISOString().slice(11, 16)} UTC on '${last.reason}' at ${last.exit})`;
    return r.ok ? `re-entered ${what} at ${r.entry}, original stop ${stop.toPrecision(7)}, risking $${r.riskUsd} (margin $${r.marginUsd})` : `could not re-enter ${what}: ${r.error}`;
  }

  /** v27.61: open Kojiro calls that were opened with no profit lock get the copy lock (worked out at the next check). */
  async relockCopies(acct: AcctId): Promise<string[]> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const hit = a.open.filter((p) => p.tf === 'signal' && p.target === null && p.lock === null && !p.locked);
      for (const p of hit) delete p.lock;
      if (hit.length) await this.save(a, acct);
      return hit.map((p) => `${p.pair} ${p.side === 1 ? 'long' : 'short'} copy: trailing stop on (arms at +0.5R, trails 0.5R, 0.3R past +1.2R)`);
    });
  }

  /** v27.60: put a closed Discord copy back open at `pct`% (see `reviveCopy`), P&L log row dropped. */
  /** v27.65: `bookMissedCopy` on an account (balance, record, P&L log via the close) + save. */
  async bookMissedCopy(acct: AcctId, r: Parameters<typeof bookMissedCopy>[1]): Promise<string> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const line = bookMissedCopy(a, r);
      await this.save(a, acct);
      return line;
    });
  }

  async bookLevelTrade(acct: AcctId, r: Parameters<typeof bookLevelTrade>[1], after: readonly Bar[]): Promise<{ line: string; closedAt: number | null }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const res = bookLevelTrade(a, r, after);
      await this.save(a, acct);
      return res;
    });
  }

  /** v27.78: `replayBotTrade` on an account; the struck close leaves the P&L log, the replayed close (if any) is logged by closePos. */
  async replayBotTrade(acct: AcctId, ref: string, capUsd: number, after: readonly Bar[], closeAt: number | null = null): Promise<string> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = replayBotTrade(a, ref, capUsd, after, closeAt);
      if (r.ids.length && this.pnlLogs()) {
        const key = pnlKey(acct);
        const raw = await this.redis.lrange(key, 0, -1);
        const keep = raw.filter((x) => {
          const row = parsePnlRow(x);
          return row !== null && !r.ids.includes(row.id);
        });
        const m = this.redis.multi().del(key);
        if (keep.length) m.rpush(key, ...keep);
        await m.exec();
        this.pnlReady.add(acct);
        this.pnlDirty(acct);
      }
      await this.save(a, acct);
      return r.line;
    });
  }

  async reviveCopy(acct: AcctId, ref: string, pct: number): Promise<string[]> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const r = reviveCopy(a, ref, pct);
      if (!r.ids.length) return r.lines;
      if (this.pnlLogs()) {
        const key = pnlKey(acct);
        const raw = await this.redis.lrange(key, 0, -1);
        const keep = raw.filter((x) => {
          const row = parsePnlRow(x);
          return row !== null && !r.ids.includes(row.id);
        });
        const m = this.redis.multi().del(key);
        if (keep.length) m.rpush(key, ...keep);
        await m.exec();
        this.pnlReady.add(acct);
        this.pnlDirty(acct);
      }
      await this.save(a, acct);
      return r.lines;
    });
  }

  /** v27.58: re-size the open Discord copies to `pct`% (see `resizeCopies`). */
  async resizeCopies(acct: AcctId, pct: number): Promise<string[]> {
    return this.serial(async () => {
      const a = await this.load(acct);
      if (!a.open.some((p) => p.tf === 'signal')) return [];
      const lines = resizeCopies(a, pct, {});
      await this.save(a, acct);
      return lines;
    });
  }

  /** v15.6: how hard the bot account trades from now on (open trades keep their size). */
  async setRiskMode(mode: RiskMode, acct: AcctId = 'bot'): Promise<RiskMode> {
    return this.serial(async () => {
      const a = await this.load(acct);
      a.riskMode = mode;
      await this.save(a, acct);
      log.info({ mode, acct }, 'bot risk mode');
      return mode;
    });
  }

  /** v17.11: the owner's profit lock on your own trades (the bot account always uses it: its tests assume it). Open
   * trades that haven't armed yet are worked out again under the new setting. */
  async setProfitLock(on: boolean): Promise<boolean> {
    return this.serial(async () => {
      const a = await this.load('me');
      a.profitLock = on;
      for (const p of a.open) if (!p.locked) p.lock = undefined;
      await this.save(a, 'me');
      return on;
    });
  }

  /** v15.6: the bot account's risk mode. */
  async riskMode(acct: AcctId = 'bot'): Promise<RiskMode> {
    return (await this.load(acct)).riskMode ?? 'normal';
  }
}
