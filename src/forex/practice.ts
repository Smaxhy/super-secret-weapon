/**
 * Forex practice account (v12.1): the owner trades by hand with fake money, live prices and leverage. Prices = Yahoo
 * 1-minute bars (refreshed ≤ every 15 s while used), bid / ask = mid ∓ half the instrument's spread. Margin = notional /
 * leverage; a position's P&L is converted to USD; when equity falls to `stopOutPct` of the margin in use everything is
 * closed (a broker stop-out). Stops / targets are checked against every 1-minute high / low since the last check.
 * Redis `fx:practice` (one account). Nothing here touches a real broker.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { oandaCandles, oandaPrices, oandaReady, loadOanda, type Granularity } from './oanda';
import { INSTRUMENTS, instrument, type Bar, type Instrument } from './types';
import { marketClock } from './calendar';
import { priceShock } from './headlines';
import { SIZING, addExposure, clampRisk, ddFactor, exposureBlock, type Exposure } from './portfolio';

const log = moduleLogger('forex-practice');
export type AcctId = 'me' | 'bot';
const keyFor = (a: AcctId) => (a === 'me' ? 'fx:practice' : 'fx:practice:bot');
/** Bot account: base risk per trade (% of equity), leverage used, most positions at once, most risk on one currency. */
export const BOT = { riskPct: SIZING.baseRiskPct, leverage: SIZING.leverage, maxOpen: SIZING.maxOpen, freshMs: 2 * 3_600_000, maxCcyRiskPct: SIZING.ccyCapPct };
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
  /** broker time of the price */
  priceT?: number;
  tradeable?: boolean;
}

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
  at: number;
}

export interface PracticeAccount {
  startUsd: number;
  balanceUsd: number;
  /** v13: highest equity seen (the bot trades smaller after a drop) */
  peakUsd?: number;
  /** v14: trades closed for the weekend, waiting to be re-opened */
  resume?: ResumeItem[];
  open: PracticePosition[];
  closed: ClosedPractice[];
  createdAt: number;
}

export const newAccount = (startUsd = 1000): PracticeAccount => ({ startUsd, balanceUsd: startUsd, open: [], closed: [], createdAt: Date.now() });

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
export function riskSummary(a: Pick<PracticeAccount, 'open' | 'peakUsd' | 'startUsd'>, mids: Record<string, number>, equityUsd: number): RiskSummary {
  const exp = currencyExposure(a.open, mids, equityUsd);
  const peak = Math.max(a.peakUsd ?? a.startUsd, equityUsd);
  const ddPct = peak > 0 ? Math.max(0, (1 - equityUsd / peak) * 100) : 0;
  const openRisk = equityUsd > 0 ? a.open.reduce((s, p) => s + positionRiskUsd(p, mids), 0) / equityUsd * 100 : 0;
  return {
    exposure: Object.entries(exp)
      .filter(([, v]) => Math.abs(v) >= 0.01)
      .map(([ccy, v]) => ({ ccy, pct: Math.round(v * 100) / 100 }))
      .sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct)),
    capPct: BOT.maxCcyRiskPct,
    ddPct: Math.round(ddPct * 10) / 10,
    ddFactor: ddFactor(ddPct),
    baseRiskPct: BOT.riskPct,
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

function closePos(a: PracticeAccount, p: PracticePosition, px: number, mids: Record<string, number>, reason: ClosedPractice['reason'], at: number): void {
  const pl = Math.round(pnlUsd(p, px, mids) * 100) / 100;
  a.balanceUsd = Math.round((a.balanceUsd + pl) * 100) / 100;
  a.open = a.open.filter((x) => x.id !== p.id);
  a.closed.unshift({ ...p, exit: px, closedAt: at, pnlUsd: pl, reason });
  a.closed = a.closed.slice(0, 200);
}

/** Close part of a position (a scale-out): realise its P&L, keep the rest open. Mutates `a`. */
function closePart(a: PracticeAccount, p: PracticePosition, frac: number, px: number, mids: Record<string, number>, at: number): number {
  const units = p.units * frac;
  const part = { ...p, units, marginUsd: Math.round(p.marginUsd * frac * 100) / 100 };
  const pl = Math.round(pnlUsd(part, px, mids) * 100) / 100;
  a.balanceUsd = Math.round((a.balanceUsd + pl) * 100) / 100;
  p.units -= units;
  p.marginUsd = Math.round(p.marginUsd * (1 - frac) * 100) / 100;
  a.closed.unshift({ ...part, id: `${p.id}-part`, exit: px, closedAt: at, pnlUsd: pl, reason: 'partial' });
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
    const inst = instrument(p.pair)!;
    const half = halves[p.pair] ?? (inst.spreadPips * inst.pip) / 2;
    for (const [t, h, l] of q.bars) {
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
  if (v.marginLevelPct !== null && v.marginLevelPct <= STOP_OUT_PCT) {
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
      const j = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> } }> } };
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
      const half = (inst.spreadPips * inst.pip) / 2;
      const prev = r?.meta?.chartPreviousClose;
      return { id: inst.id, mid, bid: mid - half, ask: mid + half, t: Date.now(), bars: bars.slice(-180), dayChangePct: prev ? Math.round(((mid / prev - 1) * 100) * 100) / 100 : null, source: 'yahoo' };
    } catch {
      // next host
    }
  }
  return null;
}

/** A lab paper trade as the bot sees it (v14: + the judge's score and the trade's exit rules). */
export interface LabOpenTrade {
  ref: string;
  strategy: string;
  tf?: string;
  pair: string;
  side: 1 | -1;
  entryT: number;
  stop: number;
  target: number | null;
  chosen: boolean;
  sizeF?: number;
  prio?: number;
  /** the signal judge: win probability, whether it passes, the bar it needs (null = no judge view) */
  judge?: { p: number; ok: boolean; need: number | null } | null;
  beAt?: number | null;
  scaleAt?: number | null;
  scaleFrac?: number | null;
  scaled?: boolean;
}

export interface OpenReq { pair: string; side: 1 | -1; marginUsd: number; leverage: number; stop?: number | null; target?: number | null; strategy?: string; ref?: string; riskPct?: number; beAt?: number | null; scaleAt?: number | null; scaleFrac?: number | null; scaled?: boolean }

export class Practice {
  private cache = new Map<string, Quote>();
  private timer: NodeJS.Timeout | null = null;
  private lock: Promise<unknown> = Promise.resolve();
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
    const q = await fetchQuote(inst);
    if (q) this.cache.set(id, q);
    return q ?? c ?? null;
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
          if (c) out[id] = c;
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

  private async load(acct: AcctId = 'me'): Promise<PracticeAccount> {
    const raw = await this.redis.get(keyFor(acct)).catch(() => null);
    if (raw) {
      try {
        return JSON.parse(raw) as PracticeAccount;
      } catch {
        // fall through
      }
    }
    return newAccount();
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
    for (const acct of ['me', 'bot'] as AcctId[]) {
      const a = await this.load(acct);
      if (!a.open.length) continue;
      const q = await this.quotes(this.neededIds(a));
      const ev = tick(a, q, Date.now());
      if (acct === 'bot' && marketClock(Date.now()).flattenNow && a.open.length) {
        const mids: Record<string, number> = {};
        for (const x of Object.values(q)) mids[x.id] = x.mid;
        for (const p of [...a.open]) {
          const qq = q[p.pair];
          closePos(a, p, qq ? (p.side === 1 ? qq.bid : qq.ask) : exitPx(p, mids[p.pair] ?? p.entry), mids, 'weekend', Date.now());
          if (p.ref) a.resume = [...(a.resume ?? []), { ref: p.ref, ...(p.strategy ? { strategy: p.strategy } : {}), pair: p.pair, side: p.side, ...(p.riskPct !== undefined ? { riskPct: p.riskPct } : {}), scaled: !!p.scaled, at: Date.now() }];
        }
        ev.push('weekend: every bot trade closed before the Friday close (re-opened after Monday\'s open if still running)');
      }
      if (ev.length) {
        log.info({ acct, ev }, 'practice account event');
        await this.save(a, acct);
      }
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
      if (quote.tradeable === false || Date.now() - (quote.priceT ?? quote.bars[quote.bars.length - 1]?.[0] ?? 0) > 30 * 60_000) return { ok: false, error: 'market is closed right now (forex: Sunday 22:00 – Friday 22:00 UTC)' };
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
      a.open.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pair: inst.id, side: req.side, units, entry, marginUsd: Math.round(req.marginUsd * 100) / 100, leverage: lev, stop, target, openedAt: Date.now(), checkedT: quote.bars[quote.bars.length - 1]?.[0] ?? Date.now(), ...(req.strategy ? { strategy: req.strategy } : {}), ...(req.ref ? { ref: req.ref } : {}), ...(req.riskPct !== undefined ? { riskPct: req.riskPct } : {}), ...(req.beAt != null ? { beAt: req.beAt } : {}), ...(req.scaleAt != null ? { scaleAt: req.scaleAt, scaleFrac: req.scaleFrac ?? 0.5, scaled: !!req.scaled } : {}) });
      return { ok: true };
    }
  }

  /**
   * Bot account: mirror the lab's live paper trades of the chosen strategies. A trade the lab opened in the last
   * 2 hours that the bot doesn't hold yet is opened at the current price with the same stop / target. Size (v13):
   * base risk × the lab's size factor (strategy record × how wild the market is) × a drawdown factor, never more than
   * `BOT.maxCcyRiskPct` of the account on one currency in one direction. Held trades follow the lab's trailing stop;
   * one the lab no longer has open (its trail / time / signal exit fired) is closed at the market.
   */
  async syncBot(labOpen: LabOpenTrade[], blockFor: (pair: string) => string | null = () => null, atr1h: Record<string, number> = {}): Promise<string[]> {
    return this.serial(async () => {
      const a = await this.load('bot');
      const events: string[] = [];
      const byRef = new Map(labOpen.map((t) => [t.ref, t]));
      const q = await this.quotes(this.neededIds(a, [...new Set(labOpen.map((t) => t.pair))]), 10_000);
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      let moved = 0;
      for (const p of [...a.open]) {
        if (!p.ref) continue;
        const lab = byRef.get(p.ref);
        if (!lab) {
          const qq = q[p.pair];
          closePos(a, p, qq ? (p.side === 1 ? qq.bid : qq.ask) : exitPx(p, mids[p.pair] ?? p.entry), mids, 'signal', Date.now());
          events.push(`closed ${p.pair} (${p.strategy})`);
          continue;
        }
        // follow the lab's trailing stop: only ever tighter, and only while it is still on the losing side of the price
        if (p.stop !== null && (p.side === 1 ? lab.stop > p.stop : lab.stop < p.stop)) {
          const qq = q[p.pair];
          const px = qq ? (p.side === 1 ? qq.bid : qq.ask) : null;
          if (px === null || (p.side === 1 ? lab.stop < px : lab.stop > px)) {
            p.stop = lab.stop;
            moved++;
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
          if (Date.now() - r.at > 4 * 86_400_000) continue;
          const lab = byRef.get(r.ref);
          if (!lab) {
            events.push(`${r.pair} (${r.strategy ?? 'bot'}) ended over the weekend, not re-opened`);
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
            continue;
          }
          const v = view(a, mids);
          const risk = (r.riskPct ?? BOT.riskPct) * (r.scaled ? 1 - (lab.scaleFrac ?? 0.5) : 1);
          const margin = Math.min((v.equityUsd * risk) / 100 / (dist / entry) / BOT.leverage, v.freeMarginUsd * SIZING.marginShare);
          if (margin < 1) continue;
          const res = await this.openIn(a, { pair: r.pair, side: r.side, marginUsd: margin, leverage: BOT.leverage, stop: lab.stop, target: lab.target, ...(r.strategy ? { strategy: r.strategy } : {}), ref: r.ref, riskPct: Math.round(risk * 100) / 100, beAt: lab.beAt ?? null, scaleAt: lab.scaleAt ?? null, scaleFrac: lab.scaleFrac ?? null, scaled: !!r.scaled });
          events.push(res.ok ? `re-opened ${r.side === 1 ? 'long' : 'short'} ${r.pair} (${r.strategy ?? 'bot'}) after the weekend` : `could not re-open ${r.pair}: ${res.error}`);
        }
        a.resume = keep;
      }
      // best-tested signals get the free slots first; one strategy holds at most `maxPerStrategy` trades
      const stratKey = (ref: string) => ref.split(':').slice(0, 2).join(':');
      const perStrategy = new Map<string, number>();
      for (const p of a.open) if (p.ref) perStrategy.set(stratKey(p.ref), (perStrategy.get(stratKey(p.ref)) ?? 0) + 1);
      const candidates = labOpen.filter((t) => t.chosen && !held.has(t.ref) && Date.now() - t.entryT <= BOT.freshMs).sort((x, y) => (y.prio ?? 0) - (x.prio ?? 0));
      for (const t of candidates) {
        const sk = stratKey(t.ref);
        if ((perStrategy.get(sk) ?? 0) >= SIZING.maxPerStrategy) {
          note(`${t.ref}:strat`, `skipped ${t.pair} (${t.strategy}): it already has ${SIZING.maxPerStrategy} trades open`);
          continue;
        }
        if (t.judge && !t.judge.ok) {
          note(`${t.ref}:judge`, `skipped ${t.pair} (${t.strategy}): the signal judge gives it a ${Math.round(t.judge.p * 100)}% chance (needs ${Math.round((t.judge.need ?? 0) * 100)}%)`);
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
          continue;
        }
        if (a.open.length >= BOT.maxOpen) break;
        const qq = q[t.pair];
        if (!qq || qq.tradeable === false) continue;
        const entry = t.side === 1 ? qq.ask : qq.bid;
        const dist = (entry - t.stop) * t.side;
        if (!(dist > 0)) continue; // price already through the stop
        const v = view(a, mids);
        const riskPct = clampRisk(BOT.riskPct, BOT.riskPct * (t.sizeF ?? 1) * ddF);
        const exp = currencyExposure(a.open, mids, v.equityUsd);
        const over = exposureBlock(exp, t.pair, t.side, riskPct, BOT.maxCcyRiskPct);
        if (over) {
          note(`${t.ref}:ccy`, `skipped ${t.pair} (${t.strategy}): already ${Math.abs(exp[over] ?? 0).toFixed(1)}% of the account riding on ${over}`);
          continue;
        }
        const notional = (v.equityUsd * riskPct) / 100 / (dist / entry);
        let margin = notional / BOT.leverage;
        margin = Math.min(margin, v.freeMarginUsd * SIZING.marginShare);
        if (margin < 1) continue;
        const actual = Math.round(((margin * BOT.leverage * (dist / entry)) / v.equityUsd) * 10_000) / 100;
        const r = await this.openIn(a, { pair: t.pair, side: t.side, marginUsd: margin, leverage: BOT.leverage, stop: t.stop, target: t.target, strategy: t.strategy, ref: t.ref, riskPct: actual, beAt: t.beAt ?? null, scaleAt: t.scaleAt ?? null, scaleFrac: t.scaleFrac ?? null, scaled: !!t.scaled });
        events.push(r.ok ? `opened ${t.side === 1 ? 'long' : 'short'} ${t.pair} (${t.strategy}), risking ${actual}% of the account${ddF < 1 ? ` (smaller: ${ddPct.toFixed(0)}% under its peak)` : ''}` : `skipped ${t.pair}: ${r.error}`);
        if (r.ok) perStrategy.set(sk, (perStrategy.get(sk) ?? 0) + 1);
      }
      await this.save(a, 'bot');
      if (events.length) log.info({ events }, 'forex bot account');
      return events;
    });
  }

  /** Per-strategy results of the bot account (to drop strategies that lose in real time). */
  async botResults(): Promise<Record<string, { n: number; pnlUsd: number }>> {
    const a = await this.load('bot');
    const out: Record<string, { n: number; pnlUsd: number }> = {};
    for (const c of a.closed) {
      if (!c.strategy) continue;
      const k = c.strategy;
      out[k] = out[k] ?? { n: 0, pnlUsd: 0 };
      // a scale-out or a weekend pause is part of one trade: its money counts, not as an extra trade
      if (c.reason !== 'partial' && c.reason !== 'weekend') out[k].n++;
      out[k].pnlUsd += c.pnlUsd;
    }
    return out;
  }

  async close(id: string | 'all', acct: AcctId = 'me'): Promise<{ ok: boolean; error?: string }> {
    return this.serial(async () => {
      const a = await this.load(acct);
      const targets = id === 'all' ? [...a.open] : a.open.filter((p) => p.id === id);
      if (!targets.length) return { ok: false, error: 'no such position' };
      const q = await this.quotes(this.neededIds(a), 5_000);
      const mids: Record<string, number> = {};
      for (const x of Object.values(q)) mids[x.id] = x.mid;
      for (const p of targets) {
        const qq = q[p.pair];
        closePos(a, p, qq ? (p.side === 1 ? qq.bid : qq.ask) : exitPx(p, mids[p.pair] ?? p.entry), mids, 'manual', Date.now());
      }
      await this.save(a, acct);
      return { ok: true };
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
    await this.serial(() => this.save(newAccount(Math.min(1_000_000, Math.max(10, startUsd))), acct));
  }
}
