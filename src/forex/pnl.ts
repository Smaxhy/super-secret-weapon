/**
 * v17.8 forex P&L + calendar (owner: "see much easier if the bot is in a trade … and a PnL and calendar view"). Pure
 * builders over the durable close log `fx:pnl:<acct>` (practice.ts writes one row per booked close: full closes, parts
 * taken, weekend legs, stop-outs, manual closes). Days use the viewer's clock: `tzOffsetMin` = JS getTimezoneOffset()
 * (minutes to ADD to local time to get UTC), the crypto calendar's convention (api/performance-calc.ts `localDay`).
 * A "trade" = a close that is not a part taken ('partial') — the Auto-bot page's rule; parts and weekend legs still count
 * as money. A trade wins when its close + the parts taken off the same position made money.
 */
import type { AccountView, ClosedPractice } from './practice';

/** One booked close (compact; one JSON row per close in the Redis list). */
export interface PnlRow {
  id: string;
  /** closed at (ms) */
  t: number;
  /** USD this close booked */
  usd: number;
  pair: string;
  side: 1 | -1;
  strategy: string | null;
  tf: string | null;
  reason: string;
  entry: number;
  exit: number;
  openedAt: number | null;
}

export interface PnlPeriod {
  pnlUsd: number;
  trades: number;
  wins: number;
}
export interface PnlStrategyDay {
  strategy: string;
  name: string;
  tf: string | null;
  trades: number;
  pnlUsd: number;
}
export interface PnlDay {
  day: string;
  pnlUsd: number;
  trades: number;
  wins: number;
  bestUsd: number | null;
  worstUsd: number | null;
  byStrategy: PnlStrategyDay[];
}
export interface PnlReport {
  acct: 'bot' | 'me' | 'cbot';
  startUsd: number;
  equityUsd: number;
  openPnlUsd: number;
  since: number | null;
  periods: { today: PnlPeriod; week: PnlPeriod; month: PnlPeriod; all: PnlPeriod };
  days: PnlDay[];
  curve: Array<[number, number]>;
  /** v27.30: the weekly log, newest week first (≤ 26) */
  weeks?: PnlWeek[];
}
/** v27.30 one week (Monday → Sunday in the viewer's clock) of booked closes */
export interface PnlWeek {
  /** Monday, YYYY-MM-DD */
  week: string;
  pnlUsd: number;
  trades: number;
  wins: number;
  bestUsd: number | null;
  worstUsd: number | null;
  byStrategy: PnlStrategyDay[];
  byPair: Array<{ pair: string; trades: number; pnlUsd: number }>;
}
export interface PnlDayTrade {
  id: string;
  pair: string;
  side: 1 | -1;
  strategy: string | null;
  name: string | null;
  tf: string | null;
  entry: number;
  exit: number;
  pnlUsd: number;
  reason: string;
  openedAt: number | null;
  closedAt: number;
  partial: boolean;
}
export interface BotStatus {
  open: number;
  openPnlUsd: number;
  equityUsd: number;
  startUsd: number;
  trades: Array<{ id: string; pair: string; side: 1 | -1; pnlUsd: number; strategy: string | null; name: string | null; tf: string | null; openedAt: number; /** v17.9: exit price behind pnlUsd + USD per 1.0 move of it (live P&L on the dashboard) */ px?: number; pnlPerPx?: number }>;
}

/** Trades with no strategy (opened by hand) are grouped under this key. */
export const MANUAL = 'manual';
const MANUAL_NAME = 'By hand';
const cents = (x: number) => Math.round(x * 100) / 100;
const px7 = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(7)) : x);
const tfOf = (c: { tf?: string; ref?: string; strategy?: string }) => (c.tf ? c.tf : c.strategy && c.ref ? c.ref.split(':')[1] || null : null);

/** The log row of a booked close. Pure. */
export function pnlRowOf(c: Pick<ClosedPractice, 'id' | 'closedAt' | 'pnlUsd' | 'pair' | 'side' | 'strategy' | 'tf' | 'ref' | 'reason' | 'entry' | 'exit' | 'openedAt'>): PnlRow {
  return { id: c.id, t: c.closedAt, usd: cents(c.pnlUsd), pair: c.pair, side: c.side === -1 ? -1 : 1, strategy: c.strategy ?? null, tf: tfOf(c), reason: c.reason, entry: px7(c.entry), exit: px7(c.exit), openedAt: Number.isFinite(c.openedAt) ? c.openedAt : null };
}

/** A stored row back (null when it isn't one). Pure. */
export function parsePnlRow(raw: string): PnlRow | null {
  try {
    const r = JSON.parse(raw) as Partial<PnlRow>;
    if (!r || typeof r.id !== 'string' || typeof r.pair !== 'string' || !Number.isFinite(r.t) || !Number.isFinite(r.usd)) return null;
    return {
      id: r.id,
      t: r.t!,
      usd: r.usd!,
      pair: r.pair,
      side: r.side === -1 ? -1 : 1,
      strategy: typeof r.strategy === 'string' ? r.strategy : null,
      tf: typeof r.tf === 'string' ? r.tf : null,
      reason: typeof r.reason === 'string' ? r.reason : 'manual',
      entry: Number(r.entry),
      exit: Number(r.exit),
      openedAt: Number.isFinite(r.openedAt) ? r.openedAt! : null,
    };
  } catch {
    return null;
  }
}

/** Viewer offset in minutes (JS getTimezoneOffset), clamped to ±14 h. */
export const clampTz = (tz: number) => (Number.isFinite(tz) ? Math.max(-840, Math.min(840, Math.round(tz))) : 0);
/** Viewer-local calendar day (YYYY-MM-DD) of a time. */
export const localDayOf = (t: number, tzOffsetMin = 0) => new Date(t - clampTz(tzOffsetMin) * 60_000).toISOString().slice(0, 10);
/** v27.21: 'adjust' = a correction row (money moved between days by the owner's say), never a trade */
export const isTrade = (r: Pick<PnlRow, 'reason'>) => r.reason !== 'partial' && r.reason !== 'adjust';
/** `abc-part`, `abc-part2` → `abc` (the position the part was taken from) */
const baseId = (id: string) => id.replace(/-part\d*$/, '');

/** Each trade's result: its close + every part taken off the same position (keyed by the close row's id). Pure. */
export function tradeTotals(rows: readonly PnlRow[]): Map<string, number> {
  const parts = new Map<string, number>();
  for (const r of rows) if (!isTrade(r)) parts.set(baseId(r.id), (parts.get(baseId(r.id)) ?? 0) + r.usd);
  const out = new Map<string, number>();
  for (const r of rows) if (isTrade(r)) out.set(r.id, cents(r.usd + (parts.get(r.id) ?? 0)));
  return out;
}

const nameOf = (strategy: string | null, names: Readonly<Record<string, string>>) => (strategy ? names[strategy] ?? strategy : MANUAL_NAME);

/** Days (viewer-local, oldest first): money booked that day, trades finished, wins, best / worst trade, per strategy. Pure. */
export function dailyPnl(rows: readonly PnlRow[], tzOffsetMin = 0, names: Readonly<Record<string, string>> = {}): PnlDay[] {
  const totals = tradeTotals(rows);
  const days = new Map<string, { pnl: number; trades: number; wins: number; best: number | null; worst: number | null; strat: Map<string, PnlStrategyDay & { raw: number }> }>();
  for (const r of rows) {
    const key = localDayOf(r.t, tzOffsetMin);
    let d = days.get(key);
    if (!d) days.set(key, (d = { pnl: 0, trades: 0, wins: 0, best: null, worst: null, strat: new Map() }));
    d.pnl += r.usd;
    const sk = `${r.strategy ?? MANUAL}:${r.tf ?? ''}`;
    let s = d.strat.get(sk);
    if (!s) d.strat.set(sk, (s = { strategy: r.strategy ?? MANUAL, name: nameOf(r.strategy, names), tf: r.tf, trades: 0, pnlUsd: 0, raw: 0 }));
    s.raw += r.usd;
    if (!isTrade(r)) continue;
    const tot = totals.get(r.id) ?? r.usd;
    d.trades++;
    s.trades++;
    if (tot > 0) d.wins++;
    d.best = d.best === null ? tot : Math.max(d.best, tot);
    d.worst = d.worst === null ? tot : Math.min(d.worst, tot);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, d]) => ({
      day,
      pnlUsd: cents(d.pnl),
      trades: d.trades,
      wins: d.wins,
      bestUsd: d.best,
      worstUsd: d.worst,
      byStrategy: [...d.strat.values()].map(({ raw, ...s }) => ({ ...s, pnlUsd: cents(raw) })).sort((a, b) => b.pnlUsd - a.pnlUsd),
    }));
}

/** v27.30: the Monday (YYYY-MM-DD) of a local day. Pure. */
export const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};
/** v27.30 (owner: "a weekly log"): weeks (viewer-local, Monday start), newest first — money, trades, wins, best / worst,
 * per strategy and per market. Pure. */
export function weeklyLog(rows: readonly PnlRow[], tzOffsetMin = 0, names: Readonly<Record<string, string>> = {}, max = 26): PnlWeek[] {
  const totals = tradeTotals(rows);
  type W = { pnl: number; trades: number; wins: number; best: number | null; worst: number | null; strat: Map<string, PnlStrategyDay & { raw: number }>; pairs: Map<string, { trades: number; raw: number }> };
  const weeks = new Map<string, W>();
  for (const r of rows) {
    const key = mondayOf(localDayOf(r.t, tzOffsetMin));
    let w = weeks.get(key);
    if (!w) weeks.set(key, (w = { pnl: 0, trades: 0, wins: 0, best: null, worst: null, strat: new Map(), pairs: new Map() }));
    w.pnl += r.usd;
    const sk = `${r.strategy ?? MANUAL}:${r.tf ?? ''}`;
    let st = w.strat.get(sk);
    if (!st) w.strat.set(sk, (st = { strategy: r.strategy ?? MANUAL, name: nameOf(r.strategy, names), tf: r.tf, trades: 0, pnlUsd: 0, raw: 0 }));
    st.raw += r.usd;
    let pp = w.pairs.get(r.pair);
    if (!pp) w.pairs.set(r.pair, (pp = { trades: 0, raw: 0 }));
    pp.raw += r.usd;
    if (!isTrade(r)) continue;
    const tot = totals.get(r.id) ?? r.usd;
    w.trades++;
    st.trades++;
    pp.trades++;
    if (tot > 0) w.wins++;
    w.best = w.best === null ? tot : Math.max(w.best, tot);
    w.worst = w.worst === null ? tot : Math.min(w.worst, tot);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, max)
    .map(([week, w]) => ({
      week,
      pnlUsd: cents(w.pnl),
      trades: w.trades,
      wins: w.wins,
      bestUsd: w.best,
      worstUsd: w.worst,
      byStrategy: [...w.strat.values()].map(({ raw, ...x }) => ({ ...x, pnlUsd: cents(raw) })).sort((a, b) => b.pnlUsd - a.pnlUsd),
      byPair: [...w.pairs.entries()].map(([pair, x]) => ({ pair, trades: x.trades, pnlUsd: cents(x.raw) })).sort((a, b) => b.pnlUsd - a.pnlUsd),
    }));
}
/** v27.30: one line for last week's phone summary. Pure. */
export function weekText(w: PnlWeek): string {
  const top = w.byStrategy.filter((x) => x.trades > 0).slice(0, 3).map((x) => `${x.name}${x.tf ? ` ${x.tf}` : ''} ${x.pnlUsd >= 0 ? '+' : '−'}$${Math.abs(x.pnlUsd).toFixed(2)}`);
  return `${w.trades} trade${w.trades === 1 ? '' : 's'}, ${w.wins} won${w.trades ? ` (${Math.round((w.wins / w.trades) * 100)}%)` : ''}${top.length ? ` · ${top.join(', ')}` : ''}`;
}

/** Today / this week (starts Monday) / this month / everything, in the viewer's clock. Pure. */
export function periods(rows: readonly PnlRow[], now: number, tzOffsetMin = 0): PnlReport['periods'] {
  const today = localDayOf(now, tzOffsetMin);
  const local = new Date(now - clampTz(tzOffsetMin) * 60_000);
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ((local.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const totals = tradeTotals(rows);
  const zero = (): PnlPeriod => ({ pnlUsd: 0, trades: 0, wins: 0 });
  const out = { today: zero(), week: zero(), month: zero(), all: zero() };
  for (const r of rows) {
    const day = localDayOf(r.t, tzOffsetMin);
    const into: PnlPeriod[] = [out.all];
    if (day === today) into.push(out.today);
    if (day >= monday && day <= today) into.push(out.week);
    if (day.slice(0, 7) === month) into.push(out.month);
    const win = isTrade(r) && (totals.get(r.id) ?? r.usd) > 0;
    for (const p of into) {
      p.pnlUsd += r.usd;
      if (isTrade(r)) p.trades++;
      if (win) p.wins++;
    }
  }
  for (const p of Object.values(out)) p.pnlUsd = cents(p.pnlUsd);
  return out;
}

/** Keep the first and last point and, per bucket, its lowest and highest (in time order) — ≤ maxPoints. Pure. */
export function downsampleCurve(pts: ReadonlyArray<[number, number]>, maxPoints = 600): Array<[number, number]> {
  maxPoints = Math.max(4, Math.floor(maxPoints));
  if (pts.length <= maxPoints) return pts.slice();
  const inner = pts.slice(1, -1);
  const buckets = Math.floor((maxPoints - 2) / 2);
  const out: Array<[number, number]> = [pts[0]!];
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * inner.length) / buckets);
    const hi = Math.floor(((b + 1) * inner.length) / buckets);
    if (hi <= lo) continue;
    let iMin = lo;
    let iMax = lo;
    for (let i = lo + 1; i < hi; i++) {
      if (inner[i]![1] < inner[iMin]![1]) iMin = i;
      if (inner[i]![1] > inner[iMax]![1]) iMax = i;
    }
    out.push(inner[Math.min(iMin, iMax)]!);
    if (iMin !== iMax) out.push(inner[Math.max(iMin, iMax)]!);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Realised equity right after each close, oldest first, from `startUsd` (first point just before the first close). Pure. */
export function equityCurve(rows: readonly PnlRow[], startUsd: number, maxPoints = 600): Array<[number, number]> {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const pts: Array<[number, number]> = [[sorted[0]!.t - 1, cents(startUsd)]];
  let eq = startUsd;
  for (const r of sorted) {
    eq += r.usd;
    pts.push([r.t, cents(eq)]);
  }
  return downsampleCurve(pts, maxPoints);
}

/** Every close on one viewer-local day, newest first (parts taken flagged). Pure. */
export function dayTrades(rows: readonly PnlRow[], day: string, tzOffsetMin = 0, names: Readonly<Record<string, string>> = {}): PnlDayTrade[] {
  return rows
    .filter((r) => localDayOf(r.t, tzOffsetMin) === day)
    .sort((a, b) => b.t - a.t)
    .map((r) => ({ id: r.id, pair: r.pair, side: r.side, strategy: r.strategy, name: r.strategy ? nameOf(r.strategy, names) : null, tf: r.tf, entry: r.entry, exit: r.exit, pnlUsd: r.usd, reason: r.reason, openedAt: r.openedAt, closedAt: r.t, partial: !isTrade(r) }));
}

type AccountIn = Pick<AccountView, 'startUsd' | 'balanceUsd' | 'equityUsd' | 'createdAt'> & { positions: ReadonlyArray<{ pnlUsd: number }> };

/** GET /api/forex/pnl. `account` null = practice not running (empty shapes). Pure. */
export function pnlReport(acct: 'bot' | 'me' | 'cbot', rows: readonly PnlRow[], account: AccountIn | null, now: number, tzOffsetMin = 0, names: Readonly<Record<string, string>> = {}): PnlReport {
  const startUsd = account?.startUsd ?? 0;
  const sum = rows.reduce((s, r) => s + r.usd, 0);
  // the curve ends at the real realised balance: when the log misses older closes (an account older than the log, the
  // first fill came from its newest 200 closes) it starts where those closes left the balance
  const base = account && rows.length && Math.abs(account.balanceUsd - sum - startUsd) > 0.01 ? account.balanceUsd - sum : startUsd;
  return {
    acct,
    startUsd,
    equityUsd: account?.equityUsd ?? 0,
    openPnlUsd: account ? cents(account.positions.reduce((s, p) => s + (Number.isFinite(p.pnlUsd) ? p.pnlUsd : 0), 0)) : 0,
    since: account?.createdAt ?? rows[0]?.t ?? null,
    periods: periods(rows, now, tzOffsetMin),
    days: dailyPnl(rows, tzOffsetMin, names),
    curve: equityCurve(rows, base, 600),
    weeks: weeklyLog(rows, tzOffsetMin, names),
  };
}

/** GET /api/forex/bot/status: is the bot in a trade, and how is each doing. Pure. */
export function botStatus(account: (Pick<AccountView, 'startUsd' | 'equityUsd'> & { positions: ReadonlyArray<AccountView['positions'][number]> }) | null, names: Readonly<Record<string, string>> = {}): BotStatus {
  if (!account) return { open: 0, openPnlUsd: 0, equityUsd: 0, startUsd: 0, trades: [] };
  const trades = account.positions
    .map((p) => ({ id: p.id, pair: p.pair, side: p.side, pnlUsd: p.pnlUsd, strategy: p.strategy ?? null, name: p.strategy ? nameOf(p.strategy, names) : null, tf: tfOf(p), openedAt: p.openedAt, ...(Number.isFinite(p.px) ? { px: p.px } : {}), ...(p.pnlPerPx !== undefined && Number.isFinite(p.pnlPerPx) ? { pnlPerPx: p.pnlPerPx } : {}) }))
    .sort((a, b) => b.openedAt - a.openedAt);
  return { open: trades.length, openPnlUsd: cents(trades.reduce((s, p) => s + (Number.isFinite(p.pnlUsd) ? p.pnlUsd : 0), 0)), equityUsd: account.equityUsd, startUsd: account.startUsd, trades };
}

/** Query of the P&L routes: acct bot | me (default bot), tz = JS getTimezoneOffset() (default 0, clamped ±14 h), day
 * YYYY-MM-DD when `needDay`. Pure. */
export function parsePnlQuery(q: { acct?: unknown; tz?: unknown; day?: unknown } | null | undefined, needDay = false): { ok: true; acct: 'bot' | 'me' | 'cbot'; tz: number; day: string | null } | { ok: false; error: string } {
  const a = q?.acct;
  if (a !== undefined && a !== '' && a !== 'bot' && a !== 'me' && a !== 'cbot') return { ok: false, error: 'acct must be bot, cbot or me' };
  const acct = a === 'me' ? 'me' : a === 'cbot' ? 'cbot' : 'bot';
  let tz = 0;
  if (q?.tz !== undefined && q.tz !== '') {
    const n = Number(q.tz);
    if (!Number.isFinite(n)) return { ok: false, error: 'tz must be a number of minutes (new Date().getTimezoneOffset())' };
    tz = clampTz(n);
  }
  if (!needDay) return { ok: true, acct, tz, day: null };
  const day = typeof q?.day === 'string' ? q.day : '';
  const t = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return { ok: false, error: 'day must be YYYY-MM-DD' };
  return { ok: true, acct, tz, day };
}
