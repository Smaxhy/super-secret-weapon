/**
 * The bot's plan (v15, owner: "I want to know what the bot is looking to trade and what the plan is"). In plain words:
 * per market what the bot is doing, which way it leans and what it is waiting for; per open trade every exit rule in
 * force (stop, break-even, part off, target or trailing take-profit, trail, time limit, weekend); and a timeline of its
 * checks, including the ones where nothing fired. Pure: built from the latest lab reports, the bot account and the
 * clock.
 */
import type { MarketClock } from './calendar';
import type { FastFiring } from './fast';
import type { MarketNow, RunNote } from './lab';
import type { MoodNow } from './mood';
import type { PracticePosition, ResumeItem, SyncReport } from './practice';
import { tfOfRef } from './practice';
import { INSTRUMENTS, TF_MIN, instrument, type Timeframe } from './types';
import { STRENGTH_MIN } from './filters';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface PlanEvent {
  t: number;
  ccy: string;
  title: string;
  impact: string;
}

export interface PlanInputs {
  now: number;
  clock: MarketClock;
  /** OANDA connected: 1-minute checks every minute (else every 2 minutes) */
  oanda: boolean;
  /** the hourly report's market cards (price, bigger-chart trends, strength, 1h / 4h signals) */
  markets: readonly MarketNow[];
  mood: MoodNow | null;
  fastFiring: Partial<Record<'15m' | '1m', FastFiring>>;
  /** strategy:chart combinations the bot trades */
  chosen: readonly string[];
  names: Record<string, string>;
  positions: ReadonlyArray<PracticePosition & { px: number; pnlUsd: number }>;
  resume: readonly ResumeItem[];
  equityUsd: number;
  lastSync: Record<string, SyncReport>;
  /** the labs' open trades of the strategies it trades: `strategy:tf:pair` → entry time */
  labOpen: Record<string, number>;
  runs: readonly RunNote[];
  /** news coming up for a pair (next hours) and what blocks a new trade right now */
  upcoming: (pair: string) => PlanEvent[];
  blockNow: (pair: string) => string | null;
  /** USD P&L of a position closed at a price */
  pnlAt: (p: PracticePosition, price: number) => number;
}

export interface PlanSignal {
  tf: string;
  name: string;
  side: 1 | -1;
  /** what happened to it, in words */
  verdict: string;
  tone: 'go' | 'wait' | 'no';
}

export interface PlanMarket {
  id: string;
  label: string;
  price: number | null;
  status: 'trading' | 'waiting' | 'blocked' | 'watching';
  headline: string;
  lean: { side: 1 | -1 | 0; why: string };
  signals: PlanSignal[];
  blocks: string[];
  /** strategies the bot trades on this market, per chart */
  watchers: Record<string, number>;
}

export interface PlanLine {
  k: 'size' | 'stop' | 'target' | 'trail' | 'be' | 'scale' | 'time' | 'rule' | 'weekend';
  text: string;
  done?: boolean;
}

export interface PlanTrade {
  id: string;
  pair: string;
  side: 1 | -1;
  strategy: string;
  name: string;
  tf: string;
  entry: number;
  px: number;
  pnlUsd: number;
  riskPct: number | null;
  lines: PlanLine[];
}

export interface BotPlan {
  at: number;
  summary: string;
  next: Array<{ tf: string; at: number }>;
  markets: PlanMarket[];
  trades: PlanTrade[];
  timeline: RunNote[];
  /** strategies it trades per chart */
  trading: Record<string, number>;
}

const TF_ORDER = ['1m', '15m', '1h', '4h'];
const TF_WORD: Record<string, string> = { '1m': '1-minute', '15m': '15-minute', '1h': 'hourly', '4h': '4-hour' };
const EXIT_RULE: Record<string, string> = {
  aboveSma5: 'closes when price crosses back over its 5-candle average',
  midBand: 'closes when price gets back to the middle Bollinger band',
  ema20: 'closes when price gets back to the 20-candle average',
};

/** Price with the market's usual digits. */
export const fmtPx = (pair: string, x: number) => x.toFixed(pair.includes('JPY') ? 3 : pair === 'XAUUSD' ? 2 : pair === 'XAGUSD' ? 3 : 5);
const pips = (pair: string, d: number) => {
  const pip = instrument(pair)?.pip ?? 0.0001;
  return Math.round((Math.abs(d) / pip) * 10) / 10;
};
const usd = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "14:00 UTC" today, "Tue 14:00 UTC" another day */
const when = (now: number, t: number) => `${new Date(t).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? '' : `${DAYS[new Date(t).getUTCDay()]} `}${hhmm(t)} UTC`;
const inMin = (now: number, t: number) => {
  const m = Math.round((t - now) / MIN);
  return m < 0 ? `${-m} min ago` : m < 90 ? `in ${m} min` : `in ${Math.round(m / 6) / 10} h`;
};

/** When each chart is checked next (UTC grid + the delay for the candle to arrive). Pure. */
export function nextChecks(now: number, oanda: boolean): Array<{ tf: string; at: number }> {
  const grid = (period: number, offset: number) => Math.floor((now - offset) / period) * period + period + offset;
  return [
    { tf: '1m', at: grid((oanda ? 60 : 120) * 1000, 20_000) },
    { tf: '15m', at: grid(15 * MIN, 40_000) },
    { tf: '1h', at: grid(HOUR, 90_000) },
    { tf: '4h', at: grid(4 * HOUR, 90_000) },
  ];
}

/**
 * Which way the bot's checks lean on a market: currency strength, the 4-hour and daily trend, and the market mood.
 * Two or more of them on one side = a lean. Pure.
 */
export function leanOf(m: Pick<MarketNow, 'id' | 'mtf' | 'strength' | 'risk'>, mood: MoodNow | null): PlanMarket['lean'] {
  let score = 0;
  const why: string[] = [];
  const st = m.strength;
  const metal = m.id.startsWith('XA');
  if (st && st.gap !== null && Math.abs(st.gap) >= STRENGTH_MIN) {
    const s = st.gap > 0 ? 1 : -1;
    score += s;
    why.push(metal ? `dollar ${s > 0 ? 'weak' : 'strong'}` : `${s > 0 ? st.base : st.quote} stronger than ${s > 0 ? st.quote : st.base}`);
  }
  const t4 = m.mtf?.h4 ?? 0;
  const td = m.mtf?.d1 ?? 0;
  if (t4 && t4 === td) {
    score += 2 * t4;
    why.push(`4-hour and daily trend ${t4 > 0 ? 'up' : 'down'}`);
  } else {
    if (t4) {
      score += t4;
      why.push(`4-hour trend ${t4 > 0 ? 'up' : 'down'}`);
    }
    if (td) {
      score += td;
      why.push(`daily trend ${td > 0 ? 'up' : 'down'}`);
    }
  }
  const risk = m.risk ?? 0;
  if (mood && mood.label !== 'calm' && Math.abs(risk) > 0.4) {
    const s = (mood.label === 'risk-on' ? 1 : -1) * Math.sign(risk);
    score += s;
    why.push(`${mood.label} market ${s > 0 ? 'favours buying' : 'favours selling'} it`);
  }
  const side: 1 | -1 | 0 = score >= 2 ? 1 : score <= -2 ? -1 : 0;
  return { side, why: why.length ? why.join(', ') : 'nothing clear: no strong currency, no trend on the bigger charts' };
}

/** The step-by-step exit plan of one bot trade. Pure. */
export function tradeLines(p: PracticePosition & { px: number }, now: number, pnlAt: (p: PracticePosition, price: number) => number): PlanLine[] {
  const out: PlanLine[] = [];
  const pair = p.pair;
  const tf = p.tf ?? (tfOfRef(p.ref) || '1h');
  const word = TF_WORD[tf] ?? tf;
  const cv = p.conviction;
  if (cv) {
    const risk = p.riskPct !== undefined ? `${p.riskPct}% of the account` : 'its risk';
    out.push({
      k: 'size',
      text:
        cv.mult > 1
          ? `Bigger size: ${cv.tier === 'verySure' ? 'very sure' : 'sure'} — ${cv.conf} of ${cv.of} checks agreed, so it risks ${risk} at ${p.leverage}× leverage (${cv.mult}× the normal size; this tier proved itself on unseen history).`
          : `Normal size: ${cv.conf} of ${cv.of} checks agreed — it risks ${risk} at ${p.leverage}× leverage.`,
    });
  }
  if (p.stop !== null) {
    const atStop = pnlAt(p, p.stop);
    if (p.tpHit) out.push({ k: 'stop', text: `Stop locked at ${fmtPx(pair, p.stop)}: if it comes back there it still closes ${usd(atStop)}.` });
    else if (p.be) out.push({ k: 'stop', text: `Stop at break-even (${fmtPx(pair, p.stop)}): this trade can no longer lose, apart from the spread.` });
    else out.push({ k: 'stop', text: `Stop ${fmtPx(pair, p.stop)} (${pips(pair, p.entry - p.stop)} pips away from entry): if hit it closes ${usd(atStop)}.` });
  } else out.push({ k: 'stop', text: 'No stop.' });
  if (p.beAt != null) out.push({ k: 'be', text: p.be ? 'Stop moved to break-even.' : `At ${fmtPx(pair, p.beAt)} (+1R) the stop moves to the entry price.`, done: !!p.be });
  if (p.scaleAt != null) out.push({ k: 'scale', text: p.scaled ? `Took ${Math.round((p.scaleFrac ?? 0.5) * 100)}% off at +1R.` : `At ${fmtPx(pair, p.scaleAt)} (+1R) it takes ${Math.round((p.scaleFrac ?? 0.5) * 100)}% off and moves the stop to entry.`, done: !!p.scaled });
  if (p.tpHit) out.push({ k: 'target', text: 'Target reached: now a trailing take-profit, no fixed exit — the winner keeps running until the trailing stop catches it.', done: true });
  else if (p.target !== null) {
    const gain = pnlAt(p, p.target);
    if (p.tpTrailPx != null) {
      const part = Math.round((p.tpFrac ?? 0) * 100);
      out.push({ k: 'target', text: `Target ${fmtPx(pair, p.target)} (+${pips(pair, p.target - p.entry)} pips, ${usd(gain)}): there it ${part ? `takes ${part}% off, ` : ''}locks the stop ${pips(pair, p.tpTrailPx)} pips behind and keeps riding with a trailing stop (trailing take-profit).` });
    } else out.push({ k: 'target', text: `Take profit at ${fmtPx(pair, p.target)} (+${pips(pair, p.target - p.entry)} pips, ${usd(gain)}).` });
  } else if (!p.trailAtr && !p.trailPx) out.push({ k: 'target', text: 'No fixed target: its strategy decides when to get out.' });
  if (p.trailPx) out.push({ k: 'trail', text: `Trailing stop-loss: the stop follows the price ${pips(pair, p.trailPx)} pips behind its best ${word} close (its starting distance), moving up with the trade at every ${word} close and never back down — at +1R it is at break-even.` });
  if (p.trailAtr) out.push({ k: 'trail', text: `Trailing stop ${p.trailAtr} × the normal ${word} candle range behind the best ${word} close, updated every ${word} close (only ever tighter).` });
  if (p.maxBars) {
    const entryT = Number((p.ref ?? '').split(':')[3]) || p.openedAt;
    const by = entryT + p.maxBars * (TF_MIN[tf as Timeframe] ?? 60) * MIN;
    out.push({ k: 'time', text: `Time limit: closed after ${p.maxBars} ${word} candles if nothing else hit — around ${when(now, by)}${by > now ? ` (${inMin(now, by)})` : ''}.` });
  }
  if (p.exitWhen && EXIT_RULE[p.exitWhen]) out.push({ k: 'rule', text: `Its strategy also ${EXIT_RULE[p.exitWhen]}.` });
  out.push({ k: 'weekend', text: "Closed 30 min before Friday's close; re-opened after Monday's open if its strategy still holds it." });
  return out;
}

/** The whole plan. Pure. */
export function buildPlan(x: PlanInputs): BotPlan {
  const { now } = x;
  const chosen = new Set(x.chosen);
  const trading: Record<string, number> = {};
  for (const k of x.chosen) {
    const tf = k.split(':')[1] ?? '';
    trading[tf] = (trading[tf] ?? 0) + 1;
  }
  const name = (id: string) => x.names[id] ?? id;
  const heldKey = new Set(x.positions.map((p) => `${p.strategy}:${p.tf ?? tfOfRef(p.ref)}:${p.pair}`));
  const syncNotes = new Map<string, { why: string; wait: boolean }>();
  for (const r of Object.values(x.lastSync)) {
    for (const s of r.skipped) syncNotes.set(`${s.strategy}:${s.tf}:${s.pair}`, { why: s.why, wait: false });
    for (const s of r.waits) syncNotes.set(`${s.strategy}:${s.tf}:${s.pair}`, { why: s.why, wait: true });
  }
  const byId = new Map(x.markets.map((m) => [m.id, m]));
  const markets: PlanMarket[] = [];
  for (const inst of INSTRUMENTS) {
    const m = byId.get(inst.id);
    const pos = x.positions.filter((p) => p.pair === inst.id);
    // signals on the newest closes, every chart
    const raw: Array<{ id: string; name: string; tf: string; side: 1 | -1; allowed: boolean; why: string | null }> = [];
    for (const f of m?.firing ?? []) raw.push({ id: f.id, name: f.name, tf: f.tf, side: f.side, allowed: f.allowed, why: f.why });
    for (const tf of ['15m', '1m'] as const) for (const f of x.fastFiring[tf]?.byPair[inst.id] ?? []) raw.push({ id: f.id, name: f.name, tf, side: f.side, allowed: f.allowed, why: f.why });
    const signals: PlanSignal[] = raw.map((f) => {
      const k = `${f.id}:${f.tf}`;
      const note = syncNotes.get(`${f.id}:${f.tf}:${inst.id}`);
      if (!chosen.has(k)) return { tf: f.tf, name: f.name, side: f.side, verdict: 'not one it trades (no edge on unseen data)', tone: 'no' };
      if (!f.allowed) return { tf: f.tf, name: f.name, side: f.side, verdict: `held back: ${f.why}`, tone: 'no' };
      if (heldKey.has(`${f.id}:${f.tf}:${inst.id}`)) return { tf: f.tf, name: f.name, side: f.side, verdict: 'in the trade', tone: 'go' };
      if (note) return { tf: f.tf, name: f.name, side: f.side, verdict: `${note.wait ? 'waiting' : 'skipped'}: ${note.why}`, tone: note.wait ? 'wait' : 'no' };
      const since = x.labOpen[`${f.id}:${f.tf}:${inst.id}`];
      if (since !== undefined && now - since > (TF_MIN[f.tf as Timeframe] ?? 60) * 2 * MIN) return { tf: f.tf, name: f.name, side: f.side, verdict: `its strategy is already in a trade here (since ${when(now, since)}): one at a time`, tone: 'no' };
      if (since !== undefined) return { tf: f.tf, name: f.name, side: f.side, verdict: 'taking it', tone: 'go' };
      return { tf: f.tf, name: f.name, side: f.side, verdict: 'not taken: its stop would sit too close for the spread', tone: 'no' };
    });
    signals.sort((a, b) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(b.tf));
    const blocks: string[] = [];
    if (!x.clock.open) blocks.push('market closed for the weekend');
    else {
      if (x.clock.noNewTrades) blocks.push('no new trades: the weekly close is near');
      if (x.clock.rollover) blocks.push('daily rollover (20:45–23:15 UTC): spreads are wide, no new trades');
      if (x.clock.sinceOpenMin >= 0 && x.clock.sinceOpenMin < 120) blocks.push('the week just opened: no new trades for the first 2 hours');
      const b = x.blockNow(inst.id);
      if (b) blocks.push(`no new trades right now: ${b}`);
    }
    for (const e of x.upcoming(inst.id).slice(0, 3)) {
      if (e.impact === 'Holiday') continue;
      if (e.t > now) blocks.push(`${e.ccy} ${e.title} ${inMin(now, e.t)} (${when(now, e.t)}): no new trades from 30 min before to 30 min after`);
    }
    const watchers: Record<string, number> = {};
    for (const k of x.chosen) {
      const tf = k.split(':')[1] ?? '';
      watchers[tf] = (watchers[tf] ?? 0) + 1;
    }
    const lean = m ? leanOf(m, x.mood) : { side: 0 as const, why: 'no hourly data yet' };
    let status: PlanMarket['status'];
    let headline: string;
    const wanted = signals.filter((s) => s.tone === 'wait');
    if (pos.length) {
      status = 'trading';
      const total = pos.reduce((s, p) => s + p.pnlUsd, 0);
      headline =
        pos.length === 1
          ? `In a ${pos[0]!.side === 1 ? 'long' : 'short'} (${name(pos[0]!.strategy ?? '')}, ${pos[0]!.tf ?? tfOfRef(pos[0]!.ref)}) since ${when(now, pos[0]!.openedAt)}: ${usd(pos[0]!.pnlUsd)} so far.`
          : `In ${pos.length} trades here: ${usd(total)} so far.`;
    } else if (wanted.length) {
      status = 'waiting';
      const w = wanted[0]!;
      headline = `Wants to ${w.side === 1 ? 'buy' : 'sell'} (${w.name}, ${w.tf}): ${w.verdict}.`;
    } else if (blocks.length && (!x.clock.open || blocks.some((b) => b.startsWith('no new trades')))) {
      status = 'blocked';
      headline = blocks[0]!.charAt(0).toUpperCase() + blocks[0]!.slice(1) + '.';
    } else {
      status = 'watching';
      const charts = TF_ORDER.filter((tf) => watchers[tf]).map((tf) => tf).join(' · ');
      headline = charts
        ? `Watching on ${charts}. ${lean.side ? `Leans to ${lean.side === 1 ? 'BUY' : 'SELL'}` : 'No clear side'}: it opens when one of its strategies fires and the checks agree.`
        : 'Watching: none of its strategies has passed its test yet.';
    }
    markets.push({ id: inst.id, label: inst.label, price: pos[0]?.px ?? m?.price ?? null, status, headline, lean, signals, blocks, watchers });
  }
  const order: Record<PlanMarket['status'], number> = { trading: 0, waiting: 1, watching: 2, blocked: 3 };
  markets.sort((a, b) => order[a.status] - order[b.status]);
  const trades: PlanTrade[] = x.positions.map((p) => ({
    id: p.id,
    pair: p.pair,
    side: p.side,
    strategy: p.strategy ?? 'bot',
    name: name(p.strategy ?? ''),
    tf: p.tf ?? (tfOfRef(p.ref) || '1h'),
    entry: p.entry,
    px: p.px,
    pnlUsd: p.pnlUsd,
    riskPct: p.riskPct ?? null,
    lines: tradeLines(p, now, x.pnlAt),
  }));
  const next = nextChecks(now, x.oanda);
  const openCharts = TF_ORDER.filter((tf) => trading[tf]);
  const nTrading = Object.values(trading).reduce((a, b) => a + b, 0);
  const pnl = x.positions.reduce((s, p) => s + p.pnlUsd, 0);
  const soon = next.filter((n) => trading[n.tf]).sort((a, b) => a.at - b.at)[0] ?? next[1]!;
  const summary = !x.clock.open
    ? `Market closed for the weekend (opens again in ${Math.round(x.clock.minutesToChange / 60)} h). ${x.resume.length ? `${x.resume.length} trade${x.resume.length > 1 ? 's' : ''} paused, re-opened after Monday's open if still running.` : 'Nothing to do until then.'}`
    : `${x.positions.length ? `In ${x.positions.length} trade${x.positions.length > 1 ? 's' : ''} (${usd(pnl)} open)` : 'No trade open'} · ${nTrading ? `${nTrading} tested setup${nTrading === 1 ? '' : 's'} (strategy × chart) on ${openCharts.join(', ')}` : 'no strategy has passed its test yet'} across ${INSTRUMENTS.length} markets · next check ${hhmm(soon.at)} UTC (${soon.tf}).`;
  return {
    at: now,
    summary,
    next,
    markets,
    trades,
    timeline: [...x.runs].sort((a, b) => b.t - a.t).slice(0, 40),
    trading,
  };
}
