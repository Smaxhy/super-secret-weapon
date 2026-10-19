/**
 * Forex practice account (v12.1): the owner trades by hand with fake money, live prices and leverage. Prices = Yahoo
 * 1-minute bars (refreshed ≤ every 15 s while used), bid / ask = mid ∓ half the instrument's spread. Margin = notional /
 * leverage; a position's P&L is converted to USD; when equity falls to `stopOutPct` of the margin in use everything is
 * closed (a broker stop-out). Stops / targets are checked against every 1-minute high / low since the last check.
 * Redis `fx:practice` (one account). Nothing here touches a real broker.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import { HEAT, maxRiskUnder, topCorrelated, type CorrBook } from './risk';
import { oandaCandles, oandaPrices, oandaReady, loadOanda, type Granularity } from './oanda';
import { INSTRUMENTS, instrument, type Bar, type Instrument } from './types';
import { marketClock } from './calendar';
import { priceShock } from './headlines';
import { spreadMultAt } from './spreads';
import { SIZING, addExposure, clampRisk, ddFactor, exposureBlock, type Exposure } from './portfolio';
import type { Tier } from './conviction';
import { SNIPER } from './sniper';

const log = moduleLogger('forex-practice');
export type AcctId = 'me' | 'bot';
const keyFor = (a: AcctId) => (a === 'me' ? 'fx:practice' : 'fx:practice:bot');
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
};
/**
 * v15.6 (owner: "I need a lot more, at least 10%+ a month"): how hard the bot account trades. Same strategies and checks in
 * every mode — only the risk per trade, leverage and how many trades may be open at once grow. Bigger months AND bigger
 * losing months: the honest test shows each level's real weekly / monthly spread before you pick one.
 */
export type RiskMode = 'normal' | 'aggressive' | 'max';
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
};
export const isRiskMode = (m: unknown): m is RiskMode => m === 'normal' || m === 'aggressive' || m === 'max';
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
  /** recent 1-minute bars (t, h, l, c), oldest first */
  bars: Array<[number, number, number, number]>;
  dayChangePct: number | null;
  /** where the price came from */
  source: 'oanda' | 'yahoo';
  barsAt?: number;
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
  /** bot trades (v15.3): USD already banked by parts taken off (and legs before a weekend pause) */
  bankedUsd?: number;
  /** v17: USD lost if the stop is hit, measured on the real fill when it opened (1 R) */
  riskUsd0?: number;
  /** v17: closing was asked for while there was no price — it closes at the first price that arrives */
  closePending?: { reason: 'signal' | 'manual' | 'weekend'; at: number } | null;
  /** bot trades (v15): the strategy's chart and the exit rules still in force (shown as the trade's plan); v15.1:
   * `trailPx` = the trailing stop-loss distance (price) */
  tf?: string;
  trailPx?: number | null;
  trailAtr?: number | null;
  maxBars?: number | null;
  exitWhen?: string | null;
}

export interface ClosedPractice extends PracticePosition {
  exit: number;
  closedAt: number;
  pnlUsd: number;
  reason: 'manual' | 'stop' | 'target' | 'stop-out' | 'signal' | 'weekend' | 'partial';
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
export const LEDGER_WHY = { stop: 0, target: 1, signal: 2, 'stop-out': 3, weekend: 4, manual: 5 } as const;
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

/** Units of base for a USD notional. Metals: 1 unit = 1 oz priced in USD. Pure. */
export function unitsFor(inst: Instrument, notionalUsd: number, mids: Record<string, number>): number | null {
  if (inst.kind === 'metal') return notionalUsd / mids[inst.id]!;
  const b = usdPer(baseOf(inst), mids);
  return b ? notionalUsd / b : null;
}

/** P&L in USD of a position at `px`. Pure. */
export function pnlUsd(p: Pick<PracticePosition, 'pair' | 'side' | 'units' | 'entry'>, px: number, mids: Record<string, number>): number {
  const inst = instrument(p.pair)!;
  const inQuote = p.side * p.units * (px - p.entry);
  if (inst.kind === 'metal') return inQuote;
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
  positions: Array<PracticePosition & { px: number; pnlUsd: number; pnlPct: number }>;
}

export function view(a: PracticeAccount, mids: Record<string, number>, halves: Record<string, number> = {}): AccountView {
  const positions = a.open.map((p) => {
    const mid = mids[p.pair] ?? p.entry;
    const px = exitPx(p, mid, halves[p.pair]);
    const pl = pnlUsd(p, px, mids);
    return { ...p, px, pnlUsd: Math.round(pl * 100) / 100, pnlPct: Math.round((pl / p.marginUsd) * 1000) / 10 };
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

/** Close a position; a bot trade's total (parts + this close) goes into its record unless it only paused for the
 * weekend. Returns this close's P&L. Mutates `a`. */
function closePos(a: PracticeAccount, p: PracticePosition, px: number, mids: Record<string, number>, reason: ClosedPractice['reason'], at: number): number {
  ensureStats(a); // an older account's record is rebuilt from the closed list BEFORE this close joins it
  const pl = Math.round(pnlUsd(p, px, mids) * 100) / 100;
  a.balanceUsd = Math.round((a.balanceUsd + pl) * 100) / 100;
  a.open = a.open.filter((x) => x.id !== p.id);
  a.closed.unshift({ ...p, exit: px, closedAt: at, pnlUsd: pl, reason });
  a.closed = a.closed.slice(0, 200);
  if (reason !== 'weekend' && reason !== 'partial') recordTrade(a, statKey(p), at, pl + (p.bankedUsd ?? 0), { ...(p.ref ? { ref: p.ref } : {}), ...(p.riskUsd0 ? { riskUsd0: p.riskUsd0 } : {}), why: reason });
  return pl;
}

/** v17: the weekend pause of a bot trade (re-opened after Monday's open while the lab still holds it). Pure. */
function resumeItemOf(p: PracticePosition, leg: number, at: number): ResumeItem {
  return { ref: p.ref!, ...(p.strategy ? { strategy: p.strategy } : {}), pair: p.pair, side: p.side, ...(p.riskPct !== undefined ? { riskPct: p.riskPct } : {}), scaled: !!p.scaled, tpHit: !!p.tpHit, lev: p.leverage, bankedUsd: Math.round(((p.bankedUsd ?? 0) + leg) * 100) / 100, ...(p.riskUsd0 ? { riskUsd0: p.riskUsd0 } : {}), at };
}

/** Close part of a position (a scale-out): realise its P&L, keep the rest open. Mutates `a`. */
function closePart(a: PracticeAccount, p: PracticePosition, frac: number, px: number, mids: Record<string, number>, at: number): number {
  const units = p.units * frac;
  const part = { ...p, units, marginUsd: Math.round(p.marginUsd * frac * 100) / 100 };
  const pl = Math.round(pnlUsd(part, px, mids) * 100) / 100;
  a.balanceUsd = Math.round((a.balanceUsd + pl) * 100) / 100;
  p.bankedUsd = Math.round(((p.bankedUsd ?? 0) + pl) * 100) / 100;
  p.units -= units;
  p.marginUsd = Math.round(p.marginUsd * (1 - frac) * 100) / 100;
  // one id per part (a trade can take part off at +1R and again at its target)
  const n = a.closed.filter((c) => c.id.startsWith(`${p.id}-part`)).length;
  a.closed.unshift({ ...part, id: `${p.id}-part${n ? n + 1 : ''}`, exit: px, closedAt: at, pnlUsd: pl, reason: 'partial' });
  a.closed = a.closed.slice(0, 200);
  return pl;
}

/** Check stops / targets on the new 1-minute bars, then the stop-out. Mutates `a`. Pure apart from that. */
export function tick(a: PracticeAccount, quotes: Record<string, Quote>, now: number): string[] {
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
        if (p.ref) a.resume = [...(a.resume ?? []), resumeItemOf(p, leg, now)];
        else recordTrade(a, statKey(p), now, leg + (p.bankedUsd ?? 0));
      }
      events.push(`${p.pair} closed at the first price after its exit (${p.closePending.reason})`);
      continue;
    }
    const inst = instrument(p.pair)!;
    const half = halves[p.pair] ?? (inst.spreadPips * inst.pip) / 2;
    for (const [t, h, l, cl] of q.bars) {
      if (t <= p.checkedT || t < p.openedAt - 60_000) continue;
      // exit side of the book: a long sells at the bid (mid − half), a short buys at the ask (mid + half)
      const worst = p.side === 1 ? l - half : h + half;
      const best = p.side === 1 ? h - half : l + half;
      if (p.stop !== null && (p.side === 1 ? worst <= p.stop : worst >= p.stop)) {
        closePos(a, p, p.stop, mids, 'stop', now);
        events.push(`${p.pair} stop hit`);
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
        closePos(a, p, p.target, mids, 'target', now);
        events.push(`${p.pair} target hit`);
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
      p.checkedT = t;
    }
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

async function fetchQuote(inst: Instrument): Promise<Quote | null> {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(inst.yahoo)}?interval=1m&range=1d`;
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const j = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number; chartPreviousClose?: number; exchangeDataDelayedBy?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> } }> } };
      const r = j.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0];
      const bars: Quote['bars'] = [];
      (r?.timestamp ?? []).forEach((ts, k) => {
        const h = q?.high?.[k];
        const l = q?.low?.[k];
        const c = q?.close?.[k];
        if (h != null && l != null && c != null && c > 0) bars.push([ts * 1000, h, l, c]);
      });
      const mid = r?.meta?.regularMarketPrice ?? bars[bars.length - 1]?.[3];
      if (!mid || !(mid > 0)) continue;
      // v16: the synthetic spread follows the measured hour-of-day profile (wider at rollover)
      const half = (inst.spreadPips * inst.pip * spreadMultAt(inst.id, Date.now(), null)) / 2;
      const prev = r?.meta?.chartPreviousClose;
      const mt = r?.meta?.regularMarketTime;
      const priceT = mt && mt > 0 ? mt * 1000 : bars[bars.length - 1]?.[0];
      const delay = r?.meta?.exchangeDataDelayedBy;
      return { id: inst.id, mid, bid: mid - half, ask: mid + half, t: Date.now(), bars: bars.slice(-180), dayChangePct: prev ? Math.round(((mid / prev - 1) * 100) * 100) / 100 : null, source: 'yahoo', ...(priceT ? { priceT } : {}), ...(delay && delay > 0 ? { delayMs: delay * 60_000 } : {}) };
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
  ref: string;
  strategy: string;
  tf?: string;
  pair: string;
  side: 1 | -1;
  entryT: number;
  /** v17: the lab's fill (the bot doesn't chase a price that ran far from it) */
  entry?: number;
  stop: number;
  target: number | null;
  chosen: boolean;
  sizeF?: number;
  prio?: number;
  /** the signal judge: win probability, whether it passes, the bar it needs (null = no judge view) */
  judge?: { p: number; ok: boolean; need: number | null } | null;
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

export interface OpenReq extends ExitPlan { pair: string; side: 1 | -1; marginUsd: number; leverage: number; stop?: number | null; target?: number | null; strategy?: string; ref?: string; riskPct?: number; conviction?: Conviction | null; sniper?: { votes: number; of: number } | null; bankedUsd?: number; /** v17: refuse a price older than this (default 30 min) */ maxQuoteAgeMs?: number; /** v17: an hourly / 4-hour trade may use a source's declared delay (Yahoo's metals) on top of the limit */ feedDelayOk?: boolean; /** v17: 1 R of a re-opened trade (else measured on this fill) */ riskUsd0?: number }

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

export class Practice {
  private cache = new Map<string, Quote>();
  private timer: NodeJS.Timeout | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  /** v17: bot-log lines already written once (kept positions, resume retries) */
  private noted = new Set<string>();
  constructor(private readonly redis: Redis) {}

  start(): void {
    this.timer = setInterval(() => void this.serial(() => this.checkOpen()).catch(() => undefined), 15_000);
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
    if (c && Date.now() - c.t < maxAgeMs) return c;
    const inst = instrument(id);
    if (!inst) return null;
    const q = feeds.allow('yahoo') ? await fetchQuote(inst) : null;
    if (q) {
      this.cache.set(id, q);
      feeds.ok('yahoo-quotes', { items: q.bars.length, asOf: q.priceT ?? null });
    } else if (feeds.allow('yahoo')) feeds.fail('yahoo-quotes', `no price for ${id}`);
    return q ?? (c ? { ...c, stale: true } : null);
  }

  async quotes(ids: readonly string[] = INSTRUMENTS.map((i) => i.id), maxAgeMs = 15_000): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    const s = await loadOanda();
    if (oandaReady(s)) {
      try {
        const fresh = ids.filter((id) => {
          const c = this.cache.get(id);
          return !c || c.source !== 'oanda' || Date.now() - c.t > 2_000;
        });
        if (fresh.length) {
          const prices = await oandaPrices(s, fresh);
          await Promise.all(prices.map(async (p) => {
            const prev = this.cache.get(p.id);
            // 1-minute bars for stop / target checks: refreshed at most every 20 s
            let bars = prev?.source === 'oanda' && Date.now() - (prev.barsAt ?? 0) < 20_000 ? prev.bars : null;
            let barsAt = prev?.barsAt ?? 0;
            if (!bars) {
              const cs = await oandaCandles(s, p.id, 'M1', 180).catch(() => []);
              bars = cs.map((c) => [c.t, c.h, c.l, c.c] as [number, number, number, number]);
              barsAt = Date.now();
            }
            const mid = (p.bid + p.ask) / 2;
            this.cache.set(p.id, { id: p.id, mid, bid: p.bid, ask: p.ask, t: Date.now(), bars, dayChangePct: prev?.dayChangePct ?? null, source: 'oanda', barsAt, priceT: p.t, tradeable: p.tradeable });
          }));
        }
        for (const id of ids) {
          const c = this.cache.get(id);
          // v17: a price OANDA didn't refresh this time is marked old (never used to open or close)
          if (c) out[id] = c.source === 'oanda' && Date.now() - c.t > 15_000 ? { ...c, stale: true } : c;
        }
        if (Object.keys(out).length) return out;
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'oanda prices failed, using yahoo');
      }
    }
    await Promise.all(ids.map(async (id) => {
      const q = await this.quote(id, maxAgeMs);
      if (q) out[id] = q;
    }));
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
  private async save(a: PracticeAccount, acct: AcctId = 'me'): Promise<void> {
    await this.redis.set(keyFor(acct), JSON.stringify(a));
  }

  /** Quotes needed to value the account: its pairs + the USD legs for conversion. */
  private neededIds(a: PracticeAccount, extra: string[] = []): string[] {
    const s = new Set<string>(extra);
    for (const p of a.open) s.add(p.pair);
    for (const id of [...s]) {
      const i = instrument(id);
      if (!i || i.kind === 'metal') continue;
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
    for (const acct of ['me', 'bot'] as AcctId[]) await this.checkOne(acct).catch((err: Error) => log.error({ acct, err: err.message }, 'practice check failed'));
  }

  private async checkOne(acct: AcctId): Promise<void> {
    const a = await this.load(acct);
    if (!a.open.length) return;
    const q = await this.quotes(this.neededIds(a));
    const ev = tick(a, q, Date.now());
    if (acct === 'bot' && marketClock(Date.now()).flattenNow && a.open.length) {
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      for (const p of [...a.open]) {
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
        if (p.ref) a.resume = [...(a.resume ?? []), resumeItemOf(p, leg, Date.now())];
        else recordTrade(a, statKey(p), Date.now(), leg + (p.bankedUsd ?? 0));
      }
      ev.push('weekend: every bot trade closed before the Friday close (re-opened after Monday\'s open if still running)');
    }
    if (ev.length) {
      log.info({ acct, ev }, 'practice account event');
      await this.save(a, acct);
    }
  }

  async snapshot(acct: AcctId = 'me'): Promise<{ account: AccountView; quotes: Record<string, Quote> }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const q = await this.quotes(INSTRUMENTS.map((i) => i.id), 20_000);
      if (tick(a, q, Date.now()).length) await this.save(a, acct);
      const mids: Record<string, number> = {};
      const halves: Record<string, number> = {};
      for (const x of Object.values(q)) {
        mids[x.id] = x.mid;
        halves[x.id] = (x.ask - x.bid) / 2;
      }
      return { account: view(a, mids, halves), quotes: q };
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
      const allowed = req.maxQuoteAgeMs === undefined ? Infinity : req.maxQuoteAgeMs + (req.feedDelayOk ? quote.delayMs ?? 0 : 0);
      if (quoteAge(quote, Date.now()) > allowed) return { ok: false, error: `the newest price is ${Math.round(quoteAge(quote, Date.now()) / 60_000)} min old${quote.delayMs ? ` (${Math.round(quote.delayMs / 60_000)}-min delayed feed)` : ''} (this chart needs ≤ ${Math.round((req.maxQuoteAgeMs ?? 0) / 60_000)} min)` };
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
        ...(req.riskPct !== undefined ? { riskPct: req.riskPct } : {}),
        ...(req.conviction ? { conviction: req.conviction } : {}),
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
      });
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
  async syncBot(labOpen: LabOpenTrade[], blockFor: (pair: string) => string | null = () => null, atr1h: Record<string, number> = {}, opts: { scope?: readonly string[]; report?: SyncReport; pairsSeen?: ReadonlySet<string>; heat?: HeatLive | null } = {}): Promise<string[]> {
    const inScope = (ref: string | undefined) => !opts.scope || opts.scope.includes(tfOfRef(ref));
    const rep = opts.report;
    return this.serial(async () => {
      const a = await this.load('bot');
      const L = limitsFor(a.riskMode);
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
      const held = new Set([...a.open.map((p) => p.ref), ...a.closed.slice(0, 200).map((p) => p.ref)]);
      const clock = marketClock(Date.now());
      const noted = new Set<string>();
      const note = (key: string, e: string) => {
        if (!noted.has(key)) events.push(e);
        noted.add(key);
      };
      const canOpen = clock.open && !clock.noNewTrades && !clock.rollover && clock.sinceOpenMin >= 120;
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
          if (!canOpen) {
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
      for (const p of a.open) {
        if (!p.ref) continue;
        perStrategy.set(stratKey(p.ref), (perStrategy.get(stratKey(p.ref)) ?? 0) + 1);
        perTf.set(tfOfRef(p.ref), (perTf.get(tfOfRef(p.ref)) ?? 0) + 1);
      }
      const fresh = (t: LabOpenTrade) => Date.now() - t.entryT <= (BOT.freshMsByTf[t.tf ?? tfOfRef(t.ref)] ?? BOT.freshMs);
      const candidates = labOpen.filter((t) => t.chosen && !held.has(t.ref) && fresh(t)).sort((x, y) => (y.prio ?? 0) - (x.prio ?? 0));
      if (rep) {
        rep.at = Date.now();
        rep.candidates += candidates.length;
        rep.heldOpen = a.open.filter((p) => inScope(p.ref)).length;
      }
      const skip = (t: LabOpenTrade, why: string, wait = false) => {
        if (rep) (wait ? rep.waits : rep.skipped).push({ pair: t.pair, strategy: t.strategy, tf: t.tf ?? tfOfRef(t.ref), side: t.side, why });
      };
      for (const t of candidates) {
        const sk = stratKey(t.ref);
        const tf = t.tf ?? tfOfRef(t.ref);
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
        if (t.judge && !t.judge.ok) {
          note(`${t.ref}:judge`, `skipped ${t.pair} (${t.strategy}): the signal judge gives it a ${Math.round(t.judge.p * 100)}% chance (needs ${Math.round((t.judge.need ?? 0) * 100)}%)`);
          skip(t, `the signal judge gives it ${Math.round(t.judge.p * 100)}% (needs ${Math.round((t.judge.need ?? 0) * 100)}%)`);
          continue;
        }
        const qs = q[t.pair];
        const why = clock.noNewTrades
          ? clock.open
            ? 'weekly close is near'
            : 'market closed'
          : clock.rollover
            ? 'daily rollover (20:45–23:15 UTC): spreads are wide'
            : clock.sinceOpenMin < 120
              ? 'the week just opened: spreads are still wide'
              : blockFor(t.pair) ?? (qs && priceShock(qs.bars, atr1h[t.pair] ?? 0) ? 'price shock: unusually big move in the last 15 min' : null);
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
        const entry = t.side === 1 ? qq.ask : qq.bid;
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
        // v15.6: the risk mode scales the base risk, leverage and every cap together
        const lev = snipe ? Math.max(SNIPER.leverage, L.leverage) : Math.max(conv?.lev ?? 0, L.leverage);
        let riskPct = snipe ? Math.max(SNIPER.riskPct, L.riskPct) * ddF : clampRisk(L.riskPct, L.riskPct * (t.sizeF ?? 1) * ddF * (conv?.mult ?? 1), conv ? L.convMaxRiskPct / L.riskPct : undefined);
        // v17: trades that move together count as one bet — smaller, or skipped, when the combined risk is full (only
        // once the honest test showed the cap cuts the drawdown; sniper trades stay outside it, as with the currency cap)
        let heatNote = '';
        if (opts.heat?.active && !snipe && v.equityUsd > 0) {
          const pos = a.open.filter((p) => !p.sniper).map((p) => ({ pair: p.pair, side: p.side, riskPct: (positionRiskUsd(p, mids) / v.equityUsd) * 100 }));
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
        const exp = currencyExposure(a.open, mids, v.equityUsd);
        const over = snipe ? null : exposureBlock(exp, t.pair, t.side, riskPct, L.ccyCapPct);
        if (over) {
          note(`${t.ref}:ccy`, `skipped ${t.pair} (${t.strategy}): already ${Math.abs(exp[over] ?? 0).toFixed(1)}% of the account riding on ${over}`);
          skip(t, `already ${Math.abs(exp[over] ?? 0).toFixed(1)}% of the account riding on ${over}`);
          continue;
        }
        const notional = (v.equityUsd * riskPct) / 100 / (dist / entry);
        let margin = notional / lev;
        margin = Math.min(margin, v.freeMarginUsd * SIZING.marginShare);
        if (margin < 1) {
          skip(t, 'not enough free margin');
          continue;
        }
        const actual = Math.round(((margin * lev * (dist / entry)) / v.equityUsd) * 10_000) / 100;
        const r = await this.openIn(a, { pair: t.pair, side: t.side, marginUsd: margin, leverage: lev, stop: t.stop, target: t.target, strategy: t.strategy, ref: t.ref, riskPct: actual, ...planOf(t), tf, ...(t.conviction ? { conviction: t.conviction } : {}), ...(snipe ? { sniper: { votes: snipe.votes, of: snipe.of } } : {}), maxQuoteAgeMs: BOT.quoteAgeMsByTf[tf] ?? 10 * 60_000, feedDelayOk: tf === '1h' || tf === '4h' });
        const sure = snipe ? ` — SNIPER: ${snipe.votes} of ${snipe.of} checks agree, risking ${actual}% at ${lev}×` : conv ? ` — ${conv.tier === 'verySure' ? 'very sure' : 'sure'} (${conv.conf} of ${conv.of} checks agree): bigger size at ${lev}×` : '';
        events.push(r.ok ? `opened ${t.side === 1 ? 'long' : 'short'} ${t.pair} (${t.strategy}, ${tf}), risking ${actual}% of the account${sure}${ddF < 1 ? ` (smaller: ${ddPct.toFixed(0)}% under its peak)` : ''}${heatNote}` : `skipped ${t.pair}: ${r.error}`);
        if (r.ok) {
          perStrategy.set(sk, (perStrategy.get(sk) ?? 0) + 1);
          perTf.set(tf, (perTf.get(tf) ?? 0) + 1);
          if (rep) rep.opened++;
        } else skip(t, r.error ?? 'could not open');
      }
      await this.save(a, 'bot');
      if (events.length) log.info({ events }, 'forex bot account');
      return events;
    });
  }

  /** v15.3: refs of the bot's open trades (no prices needed). */
  async heldRefs(): Promise<string[]> {
    const a = await this.load('bot');
    return a.open.map((p) => p.ref).filter((r): r is string => !!r);
  }

  /** v17: every finished bot trade in R (newest last). */
  async botLedger(): Promise<BotLedgerRow[]> {
    return ledgerRows(await this.load('bot'));
  }

  /** Results of the bot account per strategy and chart (`ema_cross:1h`), to drop what loses in real time. */
  async botResults(now = Date.now()): Promise<Record<string, { n: number; pnlUsd: number }>> {
    return botRecordOf(await this.load('bot'), now);
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

  async edit(id: string, stop: number | null, target: number | null, acct: AcctId = 'me'): Promise<{ ok: boolean; error?: string }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const p = a.open.find((x) => x.id === id);
      if (!p) return { ok: false, error: 'no such position' };
      p.stop = stop;
      p.target = target;
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
        return { source: 'oanda', bars: await oandaCandles(s, id, g, count) };
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
        return { source: 'yahoo', bars: bars.slice(-count) };
      } catch {
        // next host
      }
    }
    return { source: 'yahoo', bars: [] };
  }

  async reset(startUsd: number, acct: AcctId = 'me'): Promise<void> {
    await this.serial(async () => {
      const fresh = newAccount(Math.min(1_000_000, Math.max(10, startUsd)));
      // the bot keeps its risk mode across a reset
      if (acct === 'bot') {
        const mode = (await this.load('bot').catch(() => null))?.riskMode;
        if (mode) fresh.riskMode = mode;
      }
      await this.save(fresh, acct);
    });
  }

  /** v15.6: how hard the bot account trades from now on (open trades keep their size). */
  async setRiskMode(mode: RiskMode): Promise<RiskMode> {
    return this.serial(async () => {
      const a = await this.load('bot');
      a.riskMode = mode;
      await this.save(a, 'bot');
      log.info({ mode }, 'forex bot risk mode');
      return mode;
    });
  }

  /** v15.6: the bot account's risk mode. */
  async riskMode(): Promise<RiskMode> {
    return (await this.load('bot')).riskMode ?? 'normal';
  }
}
