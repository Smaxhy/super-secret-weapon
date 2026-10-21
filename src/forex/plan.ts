/**
 * The bot's plan (v15, owner: "I want to know what the bot is looking to trade and what the plan is"). In plain words:
 * per market what the bot is doing, which way it leans and what it is waiting for; per open trade every exit rule in
 * force (stop, break-even, part off, target or trailing take-profit, trail, time limit, weekend); and a timeline of its
 * checks, including the ones where nothing fired. Pure: built from the latest lab reports, the bot account and the
 * clock.
 */
import { clockFor, type MarketClock } from './calendar';
import type { FastFiring } from './fast';
import type { MarketNow, RunNote } from './lab';
import type { MoodNow } from './mood';
import type { PracticePosition, ResumeItem, SyncReport } from './practice';
import { tfOfRef } from './practice';
import { INSTRUMENTS, TF_MIN, digitsOf, instrument, isCrypto, type Timeframe } from './types';
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
  /** v18.7: does the bot account place trades from the 15m / 1m charts (default no: hourly + 4-hour only) */
  fastCharts?: boolean;
  /** v23: strategies allowed to trade the 15-minute chart even while `fastCharts` is off (the ICT session rules) */
  fastStrategies?: string[];
  /** v27.2: market → the only strategies the bot trades there (FX_CONFIG.marketPlan) */
  marketPlan?: Record<string, string[]>;
  /** v27.3: focus markets (FX_CONFIG.focus): 'only' = no new trades elsewhere; always listed first */
  focus?: { mode: 'only' | 'prefer'; markets: string[] };
  /** v27.10: per market, the strategy:chart rows proven there on their own — they trade past the focus list / market plan */
  proven?: Record<string, string[]>;
  /** v22.1 fix: which desk's markets this plan is for (unset = every instrument, the pre-v22 behaviour) */
  universe?: 'fx' | 'crypto';
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
  /** v20.2: strict mode in force (edge-only rows, N market checks per trade) — the plan says so in words */
  strict?: { mode: 'edge' | 'quality' | 'off'; minAgree: number } | null;
}

export interface PlanSignal {
  tf: string;
  name: string;
  side: 1 | -1;
  /** what happened to it, in words */
  verdict: string;
  tone: 'go' | 'wait' | 'no';
}

/** v20.2: one of the four market checks and which way it points right now (0 = no reading / no clear side) */
export interface PlanCheck {
  name: 'strength' | '4h' | 'daily' | 'mood';
  side: 1 | -1 | 0;
  /** short words for the pip's tooltip */
  text: string;
}

export interface PlanMarket {
  id: string;
  label: string;
  price: number | null;
  status: 'trading' | 'waiting' | 'blocked' | 'watching';
  headline: string;
  lean: { side: 1 | -1 | 0; why: string };
  /** v20.2: the four checks (strength gap, 4-hour trend, daily trend, mood) one by one */
  checks: PlanCheck[];
  /** v20.2: what it is waiting for here, in one plain sentence */
  plan: string;
  signals: PlanSignal[];
  blocks: string[];
  /** strategies the bot trades on this market, per chart */
  watchers: Record<string, number>;
  /** v27.3: one of the desk's focus markets */
  focus?: boolean;
}

export interface PlanLine {
  k: 'size' | 'stop' | 'target' | 'trail' | 'be' | 'lock' | 'scale' | 'time' | 'rule' | 'weekend' | 'closing';
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

/** v20.2: the bot's state in one word + one line, and what the next look will do */
export interface PlanMode {
  kind: 'closed' | 'trading' | 'waiting' | 'nothing_proven' | 'scanning';
  word: string;
  line: string;
}

export interface BotPlan {
  at: number;
  summary: string;
  /** v20.2 */
  mode: PlanMode;
  /** v20.2: the next look and what happens then */
  nextLook: { tf: string; at: number; does: string };
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
export const fmtPx = (pair: string, x: number) => x.toFixed(digitsOf(pair));
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
export function nextChecks(now: number, _oanda = false): Array<{ tf: string; at: number }> {
  const grid = (period: number, offset: number) => Math.floor((now - offset) / period) * period + period + offset;
  // v18.8: the 1-minute chart is off altogether (FX_FAST.tfs); the OANDA flag only mattered for its cadence
  return [
    { tf: '15m', at: grid(15 * MIN, 40_000) },
    { tf: '1h', at: grid(HOUR, 90_000) },
    { tf: '4h', at: grid(4 * HOUR, 90_000) },
  ];
}

/** v20.2: the four market checks one by one (what the strict mode counts before a trade). Pure. */
export function checksOf(m: Pick<MarketNow, 'id' | 'mtf' | 'strength' | 'risk'>, mood: MoodNow | null): PlanCheck[] {
  const st = m.strength;
  const metal = m.id.startsWith('XA');
  const gapSide: 1 | -1 | 0 = st && st.gap !== null && Math.abs(st.gap) >= STRENGTH_MIN ? (st.gap > 0 ? 1 : -1) : 0;
  const t4 = (m.mtf?.h4 ?? 0) as 1 | -1 | 0;
  const td = (m.mtf?.d1 ?? 0) as 1 | -1 | 0;
  const risk = m.risk ?? 0;
  const moodSide: 1 | -1 | 0 = mood && mood.label !== 'calm' && Math.abs(risk) > 0.4 ? (((mood.label === 'risk-on' ? 1 : -1) * Math.sign(risk)) as 1 | -1) : 0;
  const arrow = (x: 1 | -1 | 0, up = 'up', down = 'down', none = 'no clear side') => (x === 1 ? up : x === -1 ? down : none);
  return [
    { name: 'strength', side: gapSide, text: st && st.gap !== null ? (metal ? `dollar ${arrow(gapSide, 'weak', 'strong', 'neutral')}` : `${gapSide === 1 ? st.base : gapSide === -1 ? st.quote : 'neither'} stronger${gapSide ? ` (gap ${st.gap >= 0 ? '+' : ''}${st.gap.toFixed(2)})` : ''}`) : 'no strength reading' },
    { name: '4h', side: t4, text: `4-hour trend ${arrow(t4, 'up', 'down', 'flat')}` },
    { name: 'daily', side: td, text: `daily trend ${arrow(td, 'up', 'down', 'flat')}` },
    { name: 'mood', side: moodSide, text: mood ? (moodSide ? `${mood.label} market favours ${moodSide === 1 ? 'buying' : 'selling'} it` : `${mood.label} market: no say here`) : 'no mood reading' },
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
  // v17: its exit already fired, but there was no live price to close at
  if (p.closePending) out.push({ k: 'closing', text: `Closing: ${p.closePending.reason === 'manual' ? 'you closed it' : p.closePending.reason === 'signal' ? "its strategy's exit fired" : 'weekend close'} while there was no live price — it closes at the first real price (never at a made-up one).` });
  if (p.sniper) {
    out.push({ k: 'size', text: `SNIPER trade: ${p.sniper.votes} of ${p.sniper.of} independent checks agreed (a level that proved itself on unseen history), so it risks ${p.riskPct ?? '?'}% of the account at ${p.leverage}× — the one big bet it allows at a time.` });
  } else if (cv) {
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
    else if (p.locked) out.push({ k: 'stop', text: `Profit locked: stop at ${fmtPx(pair, p.stop)} — if it comes back there it still closes ${usd(atStop)}.` });
    else if (p.be) out.push({ k: 'stop', text: `Stop at break-even (${fmtPx(pair, p.stop)}): this trade can no longer lose, apart from the spread.` });
    else out.push({ k: 'stop', text: `Stop ${fmtPx(pair, p.stop)} (${pips(pair, p.entry - p.stop)} pips away from entry): if hit it closes ${usd(atStop)}.` });
  } else out.push({ k: 'stop', text: 'No stop.' });
  // v17.11 the owner's profit lock
  if (p.lock) {
    const L = p.lock;
    out.push(
      p.locked
        ? { k: 'lock', text: `Profit lock on: the stop trails ${pips(pair, L.gap)} pips behind the best price, checked every second, and only ever moves with the trade.`, done: true }
        : { k: 'lock', text: `Profit lock: at ${fmtPx(pair, L.at)} (${usd(pnlAt(p, L.at))}, a third of the way to the target) the stop jumps past the entry to ${fmtPx(pair, L.to)} (${usd(pnlAt(p, L.to))}), then trails ${pips(pair, L.gap)} pips behind the best price.` },
    );
  }
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
  const nMk = x.markets.length; // v22.1: the markets THIS plan covers (forex or the coins), not every instrument
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
  // v22.1 fix: each desk's plan lists only ITS markets (the forex plan had the coins in it and the coin plan the 14 forex pairs)
  const insts = x.universe ? INSTRUMENTS.filter((i) => (x.universe === 'crypto' ? i.kind === 'crypto' : i.kind !== 'crypto')) : INSTRUMENTS;
  for (const inst of insts) {
    const m = byId.get(inst.id);
    const pos = x.positions.filter((p) => p.pair === inst.id);
    // signals on the newest closes, every chart
    const raw: Array<{ id: string; name: string; tf: string; side: 1 | -1; allowed: boolean; why: string | null }> = [];
    for (const f of m?.firing ?? []) raw.push({ id: f.id, name: f.name, tf: f.tf, side: f.side, allowed: f.allowed, why: f.why });
    for (const tf of ['15m', '1m'] as const) for (const f of x.fastFiring[tf]?.byPair[inst.id] ?? []) raw.push({ id: f.id, name: f.name, tf, side: f.side, allowed: f.allowed, why: f.why });
    const signals: PlanSignal[] = raw.map((f) => {
      const k = `${f.id}:${f.tf}`;
      const note = syncNotes.get(`${f.id}:${f.tf}:${inst.id}`);
      const fo = x.focus;
      const pr = !!x.proven?.[inst.id]?.includes(k);
      if (!pr && fo?.mode === 'only' && fo.markets.length && !isCrypto(inst.id) && !fo.markets.includes(inst.id)) return { tf: f.tf, name: f.name, side: f.side, verdict: `not a focus market (the bot trades ${fo.markets.map((id) => instrument(id)?.label ?? id).join(', ')})`, tone: 'no' };
      const only = x.marketPlan?.[inst.id];
      if (only && !only.includes(f.id) && !pr) return { tf: f.tf, name: f.name, side: f.side, verdict: `not on this market's list (${inst.label} trades only ${only.join(', ')})`, tone: 'no' };
      if (!only && !chosen.has(k) && !pr) return { tf: f.tf, name: f.name, side: f.side, verdict: 'not one it trades (no edge on unseen data)', tone: 'no' };
      if ((f.tf === '1m' || f.tf === '15m') && !x.fastCharts && !x.fastStrategies?.includes(f.id)) return { tf: f.tf, name: f.name, side: f.side, verdict: 'lab only: the bot trades the hourly and 4-hour charts', tone: 'no' };
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
    const ck = isCrypto(inst.id) ? clockFor(inst.id, now) : x.clock; // v22: a coin market is open all week
    if (!ck.open) blocks.push('market closed for the weekend');
    else {
      if (ck.noNewTrades) blocks.push('no new trades: the weekly close is near');
      if (ck.rollover) blocks.push('daily rollover (20:45–23:15 UTC): spreads are wide, no new trades');
      if (ck.sinceOpenMin >= 0 && ck.sinceOpenMin < 120) blocks.push('the week just opened: no new trades for the first 2 hours');
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
    const checks: PlanCheck[] = m ? checksOf(m, x.mood) : [];
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
    } else if (blocks.length && (!ck.open || blocks.some((b) => b.startsWith('no new trades')))) {
      status = 'blocked';
      headline = blocks[0]!.charAt(0).toUpperCase() + blocks[0]!.slice(1) + '.';
    } else {
      status = 'watching';
      const charts = TF_ORDER.filter((tf) => watchers[tf]).map((tf) => tf).join(' · ');
      headline = charts
        ? `Watching on ${charts}. ${lean.side ? `Leans to ${lean.side === 1 ? 'BUY' : 'SELL'}` : 'No clear side'}: it opens when one of its strategies fires and the checks agree.`
        : 'Watching: none of its strategies has passed its test yet.';
    }
    // v20.2: what it is waiting for here, in one plain sentence
    const need = x.strict?.minAgree ?? 0;
    const upCount = checks.filter((c) => c.side === 1).length;
    const downCount = checks.filter((c) => c.side === -1).length;
    const nChosen = Object.values(watchers).reduce((a, b) => a + b, 0);
    const checksWord = (side: 1 | -1) => `${side === 1 ? upCount : downCount} of ${checks.length} checks ${side === 1 ? 'up' : 'down'}`;
    let plan: string;
    if (status === 'trading') plan = headline;
    else if (!ck.open) plan = 'Market closed: nothing to do until it opens.';
    else if (!x.proven?.[inst.id]?.length && x.focus?.mode === 'only' && x.focus.markets.length && !isCrypto(inst.id) && !x.focus.markets.includes(inst.id)) plan = 'Not a focus market: the lab keeps testing it and shows it here, but the bot opens no new trades on it.';
    else if (!nChosen) plan = `Nothing to wait for: no strategy ${x.strict?.mode === 'quality' ? 'clears the quality bar' : 'has passed the unseen exam'} yet, so it will not trade here until one does.`;
    else if (status === 'waiting') {
      const w = wanted[0]!;
      plan = `A proven strategy (${w.name}, ${w.tf}) fired to ${w.side === 1 ? 'buy' : 'sell'} — ${w.verdict}.`;
    } else if (status === 'blocked') plan = `${blocks[0]!.charAt(0).toUpperCase() + blocks[0]!.slice(1)}. It will look again at the next candle close.`;
    else if (lean.side) plan = `Leans ${lean.side === 1 ? 'BUY' : 'SELL'} (${checksWord(lean.side)}). Waiting for one of its ${nChosen} proven setup${nChosen === 1 ? '' : 's'} to fire ${lean.side === 1 ? 'long' : 'short'} at a candle close${need ? ` with ${need}+ checks on its side` : ''} — then it opens at market.`;
    else plan = `No clear side (${upCount} check${upCount === 1 ? '' : 's'} up, ${downCount} down). Waiting for one of its ${nChosen} proven setup${nChosen === 1 ? '' : 's'} to fire at a candle close${need ? ` with ${need}+ of the ${checks.length || 4} checks on its side` : ''} — until then it does nothing here.`;
    markets.push({ id: inst.id, label: inst.label, price: pos[0]?.px ?? m?.price ?? null, status, headline, lean, checks, plan, signals, blocks, watchers, ...(x.focus?.markets.includes(inst.id) ? { focus: true } : {}) });
  }
  const order: Record<PlanMarket['status'], number> = { trading: 0, waiting: 1, watching: 2, blocked: 3 };
  markets.sort((a, b) => Number(!!b.focus) - Number(!!a.focus) || order[a.status] - order[b.status]); // v27.3: focus markets first
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
  const coins = x.markets.filter((m) => isCrypto(m.id)).length;
  const summary = !x.clock.open && !coins
    ? `Market closed for the weekend (opens again in ${Math.round(x.clock.minutesToChange / 60)} h). ${x.resume.length ? `${x.resume.length} trade${x.resume.length > 1 ? 's' : ''} paused, re-opened after Monday's open if still running.` : 'Nothing to do until then.'}`
    : `${x.positions.length ? `In ${x.positions.length} trade${x.positions.length > 1 ? 's' : ''} (${usd(pnl)} open)` : 'No trade open'} · ${nTrading ? `${nTrading} tested setup${nTrading === 1 ? '' : 's'} (strategy × chart) on ${openCharts.join(', ')}` : 'no strategy has passed its test yet'} across ${nMk} markets · next check ${hhmm(soon.at)} UTC (${soon.tf}).`;
  // v20.2: the state in one word, and what the next look does
  const waitingMkts = markets.filter((mk) => mk.status === 'waiting');
  const need = x.strict?.minAgree ?? 0;
  const mode: PlanMode = !x.clock.open && !coins
    ? { kind: 'closed', word: 'Market closed', line: `Forex opens again in ${Math.round(x.clock.minutesToChange / 60)} h. ${x.resume.length ? `${x.resume.length} paused trade${x.resume.length > 1 ? 's' : ''} re-open after Monday's open if still running.` : 'Nothing to do until then.'}` }
    : x.positions.length
      ? { kind: 'trading', word: `In ${x.positions.length} trade${x.positions.length > 1 ? '' : ''}${x.positions.length > 1 ? 's' : ''}`, line: `${usd(pnl)} open. It manages the stop and target every second and looks for new setups at every candle close.` }
      : !nTrading
        ? { kind: 'nothing_proven', word: 'Nothing qualifies yet', line: x.strict?.mode === 'quality' ? 'No strategy clears the quality bar (strict mode: 30+ unseen trades at 0.05R+ a trade with profit factor 1.2+, positive before the split, beats random and its luck twins), so it trades nothing. The lab re-grades every strategy each hour; the moment one clears it, it is put to work.' : `No strategy has passed the unseen exam${x.strict?.mode === 'edge' ? ' (strict mode: only Edge rows trade)' : ''}, so it trades nothing. The lab re-grades every strategy each hour; the moment one earns Edge it is put to work.` }
        : waitingMkts.length
          ? { kind: 'waiting', word: 'Waiting for a setup', line: `${waitingMkts.length} market${waitingMkts.length > 1 ? 's have' : ' has'} a proven strategy firing but something holds it back (${waitingMkts[0]!.label}: ${waitingMkts[0]!.signals.find((sg) => sg.tone === 'wait')?.verdict ?? 'waiting'}). ${nTrading} proven setup${nTrading === 1 ? '' : 's'} watched on ${nMk} markets.` }
          : { kind: 'scanning', word: 'Waiting for a setup', line: `Nothing has fired. It watches ${nTrading} proven setup${nTrading === 1 ? '' : 's'} (strategy × chart) on ${nMk} markets and opens only when one fires${need ? ` with ${need}+ market checks on its side` : ''} and no news is in the way.` };
  const nextLook = {
    tf: soon.tf,
    at: soon.at,
    does: !x.clock.open && !coins
      ? 'Nothing until the market opens.'
      : !x.clock.open
        ? `Forex is closed for the weekend (opens again in ${Math.round(x.clock.minutesToChange / 60)} h); it reads the ${TF_WORD[soon.tf] ?? soon.tf} candles of the ${coins} coin market${coins > 1 ? 's' : ''} only.`
      : !nTrading
        ? `Re-reads every ${TF_WORD[soon.tf] ?? soon.tf} candle on ${nMk} markets; with no proven strategy it opens nothing, but the hourly re-grade may promote one.`
        : `Reads the ${TF_WORD[soon.tf] ?? soon.tf} candle that just closed on ${nMk} markets: did any of the ${trading[soon.tf] ?? nTrading} proven ${soon.tf} setup${(trading[soon.tf] ?? nTrading) === 1 ? '' : 's'} fire? If one did${need ? `, ${need}+ checks agree` : ''}, no news or rollover blocks it and the caps allow, it opens at market with that strategy's stop and target.`,
  };
  return {
    at: now,
    summary,
    mode,
    nextLook,
    next,
    markets,
    trades,
    timeline: [...x.runs].sort((a, b) => b.t - a.t).slice(0, 40),
    trading,
  };
}
