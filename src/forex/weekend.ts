/**
 * v27.32 weekend review (owner: "the market is closing this weekend, crypto is of course trading — recap everything from
 * the past week and think how it can improve itself all weekend, so it's fully prepared and ready when markets are live
 * again on Monday; use the weekend as a hyper-learning experience").
 *
 * On Saturday and Sunday (forex: while the market is closed; coins: UTC Saturday / Sunday) each desk builds a WEEK RECAP
 * every few hours from what the bot already records:
 *   - money: this week's P&L log (wins, best / worst, per strategy, per market) vs last week;
 *   - live vs tested: per strategy:chart the bot's own R this week (R ledger) next to the lab's unseen avg R;
 *   - the chosen list at the start of the week vs now (what earned / lost its place);
 *   - losses: the loss review's normal / avoidable counts and causes this week;
 *   - held back: the shadow book's finished refusals this week per reason — what each hold-back rule saved or cost;
 *   - near misses: the rows (and per-market cells) closest to the strict test, with exactly what each still misses;
 *   - Monday: the high-impact news of the coming week, what is live, and a READINESS checklist (lab ran without errors,
 *     prices fresh, something passes the bar, no stray open trades on a closed market, account readable).
 * Optionally ONE Claude review a weekend day per desk (small budget) reads the recap and writes what went well / wrong and
 * ideas to test. DISPLAY ONLY — nothing here changes a rule, a size or the chosen list: every change still has to pass
 * the lab's strict test (that is what keeps "learning" from turning into curve-fitting on one week of trades).
 * Before forex opens on Sunday a "ready for Monday" push goes to the phone (or a "not ready" one naming the problem).
 */
import Anthropic from '@anthropic-ai/sdk';
import type Redis from 'ioredis';
import { priceFor } from '../learner/ai-coach';
import { moduleLogger } from '../lib/logger';
import type { CalEvent, MarketClock } from './calendar';
import type { LossReview } from './loss-review';
import { mondayOf, type PnlWeek } from './pnl';
import type { BotLedgerRow } from './practice';
import { LEDGER_WHY } from './practice';
import type { ShadowTrade } from './shadow';

const log = moduleLogger('fx-weekend');

export const WEEKEND = {
  on: true,
  /** rebuild the recap at most this often over the weekend */
  everyHours: 4,
  /** the AI review: once per desk per weekend day, its own daily budget (also counted in the coach's `ai:spend:<day>`) */
  ai: true,
  aiBudgetUsd: 0.3,
  /** "ready for Monday" push this many minutes before forex opens (Sunday 17:00 New York) */
  readyPushMin: 90,
  /** a live strategy whose live avg R is this far under its tested avg R (with 3+ trades) is flagged */
  liveGapR: 0.5,
  /** a hold-back reason whose finished refusals made / lost this many R this week is called out */
  heldBackR: 3,
};

/** Pure: is it the weekend for this desk? Forex: the market is closed. Coins: UTC Saturday or Sunday. */
export function isWeekendFor(universe: 'fx' | 'crypto', clock: MarketClock, now: number): boolean {
  if (universe === 'fx') return !clock.open;
  const d = new Date(now).getUTCDay();
  return d === 6 || d === 0;
}

/** what the recap reads from a lab row (lab.ts Row) */
export interface RecapRow {
  id: string;
  name: string;
  tf: string;
  verdict: 'edge' | 'maybe' | 'no';
  why: string;
  inSample: { n: number; avgR: number };
  outSample: { n: number; avgR: number; pf: number | null };
  stats?: { dsr: number };
  mc?: { pProfit: number } | null;
  markets?: Array<{ pair: string; n: number; avgR: number; pf: number | null; inN: number; inAvgR: number; mcP: number | null }>;
  skip?: { sessions: number[]; pairs: string[] };
}

export interface RecapInput {
  universe: 'fx' | 'crypto';
  now: number;
  /** this week's and last week's P&L log entries (pnl.ts weeklyLog, UTC) */
  week: PnlWeek | null;
  prevWeek: PnlWeek | null;
  ledger: readonly BotLedgerRow[];
  rows: readonly RecapRow[];
  /** strategy:tf keys live now, and at the start of the week (chosen history; null = unknown) */
  chosen: readonly string[];
  chosenAtStart: readonly string[] | null;
  /** per market: strategy:tf rows proven on it alone (lab.ts provenCells) */
  proven: Readonly<Record<string, string[]>>;
  dropped: readonly string[];
  losses: readonly LossReview[];
  shadow: readonly ShadowTrade[];
  events: readonly CalEvent[];
  ready: {
    labRanAt: number | null;
    labError: string | null;
    staleMarkets: readonly string[];
    openPositions: number;
    riskMode: string;
    equityUsd: number | null;
    /** minutes until forex opens (null = a coin desk / open) */
    opensInMin: number | null;
  };
}

export interface LiveCheck {
  key: string;
  name: string;
  liveN: number;
  liveR: number;
  liveAvgR: number | null;
  testN: number;
  testAvgR: number | null;
  /** in_line / worse / better than tested, or too few live trades to say */
  vs: 'in_line' | 'worse' | 'better' | 'too_few';
}
export interface NearMiss {
  key: string;
  name: string;
  /** null = the whole row (every market), else the one market */
  pair: string | null;
  n: number;
  avgR: number;
  pf: number | null;
  missing: string[];
}
export interface WeekendRecap {
  at: number;
  universe: 'fx' | 'crypto';
  /** Monday the recap's week starts on (UTC, YYYY-MM-DD) */
  week: string;
  headline: string;
  money: { pnlUsd: number; trades: number; wins: number; winPct: number | null; bestUsd: number | null; worstUsd: number | null; prevPnlUsd: number | null; byStrategy: PnlWeek['byStrategy']; byPair: PnlWeek['byPair'] };
  live: LiveCheck[];
  list: { now: string[]; added: string[]; removed: string[]; proven: Array<{ pair: string; keys: string[] }> };
  losses: { n: number; normal: number; avoidable: number; pending: number; usd: number; causes: Array<{ cause: string; n: number; usd: number }> };
  heldBack: Array<{ kind: string; label: string; n: number; done: number; totalR: number }>;
  nearMisses: NearMiss[];
  monday: { events: Array<{ t: number; ccy: string; title: string }>; riskMode: string };
  ready: { ok: boolean; checks: Array<{ ok: boolean; text: string }> };
  lessons: string[];
}

const SHORT: Record<string, string> = {
  not_chosen: 'not a live strategy',
  cooldown: 'cooling off after a close',
  caps: 'slots full',
  judge_missing: 'signal judge had no score',
  judge_no: 'signal judge said no',
  agree: 'market checks against it',
  market_rec: 'losing record on that market',
  solo: 'Fibonacci without a partner',
  check_data: 'filter data missing',
  stale_feed: 'price feed lagging',
  clock: 'market clock (rollover / weekend)',
  news: 'news pause',
  shock: 'price shock pause',
  late: 'price ran too far before entry',
  ccy_cap: 'currency cap',
  heat: 'correlated-risk cap',
  margin: 'not enough margin',
  resting: 'resting order',
  streak: 'losing-streak brake',
  doubled: 'one bet per market and side',
  other: 'other',
};
const SESS = ['Asia', 'London', 'NY open', 'NY afternoon'];
const r2 = (x: number) => Math.round(x * 100) / 100;
const usdTxt = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;

/** Pure: what a row (or one market of it) still misses on the strict bar. Empty = it passes. */
export function missingFor(x: { n: number; avgR: number; pf: number | null; inN?: number; inAvgR: number; dsr?: number | null; mcP?: number | null }, cell: boolean): string[] {
  const out: string[] = [];
  if (x.n < 30) out.push(`${30 - x.n} more unseen trades (has ${x.n})`);
  if (!(x.avgR >= (cell ? 0.1 : 0))) out.push(cell ? `unseen ${x.avgR}R a trade (needs 0.1R+)` : `loses on unseen data (${x.avgR}R)`);
  if ((x.pf ?? 99) < (cell ? 1.3 : 1.2)) out.push(`profit factor ${x.pf} (needs ${cell ? 1.3 : 1.2}+)`);
  if (!(x.inAvgR > 0)) out.push(`lost before the 70/30 line (${x.inAvgR}R)`);
  if (cell && (x.inN ?? 0) < 20) out.push(`${20 - (x.inN ?? 0)} more trades before the line`);
  if (cell && (x.mcP ?? 0) < 0.95) out.push(`Monte Carlo ${Math.round((x.mcP ?? 0) * 100)}% (needs 95%)`);
  if (!cell && x.dsr != null && x.dsr < 0.5) out.push(`deflated Sharpe ${Math.round(x.dsr * 100)}% (needs 50%)`);
  return out;
}

/** Pure: the week recap. */
export function buildRecap(x: RecapInput): WeekendRecap {
  const monday = mondayOf(new Date(x.now).toISOString().slice(0, 10));
  const weekStart = Date.parse(`${monday}T00:00:00Z`);
  const names = new Map(x.rows.map((r) => [`${r.id}:${r.tf}`, r.name]));
  const nameOf = (key: string) => {
    const [id, tf] = key.split(':');
    return `${names.get(key) ?? id} ${tf ?? ''}`.trim();
  };
  const rowOf = new Map(x.rows.map((r) => [`${r.id}:${r.tf}`, r]));

  // money
  const w = x.week;
  const money = {
    pnlUsd: r2(w?.pnlUsd ?? 0),
    trades: w?.trades ?? 0,
    wins: w?.wins ?? 0,
    winPct: w && w.trades ? Math.round((w.wins / w.trades) * 100) : null,
    bestUsd: w?.bestUsd ?? null,
    worstUsd: w?.worstUsd ?? null,
    prevPnlUsd: x.prevWeek ? r2(x.prevWeek.pnlUsd) : null,
    byStrategy: w?.byStrategy ?? [],
    byPair: (w?.byPair ?? []).slice(0, 8),
  };

  // live vs tested — every key the bot traded this week or has live now
  const ledgerWeek = x.ledger.filter((l) => l.closedAt >= weekStart && l.why !== LEDGER_WHY.manual);
  const keys = new Set<string>([...x.chosen, ...ledgerWeek.map((l) => l.key)]);
  const live: LiveCheck[] = [...keys].map((key) => {
    const ls = ledgerWeek.filter((l) => l.key === key && l.r !== null);
    const liveR = r2(ls.reduce((n, l) => n + (l.r ?? 0), 0));
    const row = rowOf.get(key);
    const testAvgR = row ? row.outSample.avgR : null;
    const liveAvgR = ls.length ? r2(liveR / ls.length) : null;
    let vs: LiveCheck['vs'] = 'too_few';
    if (ls.length >= 3 && liveAvgR !== null && testAvgR !== null) vs = liveAvgR < testAvgR - WEEKEND.liveGapR ? 'worse' : liveAvgR > testAvgR + WEEKEND.liveGapR ? 'better' : 'in_line';
    return { key, name: nameOf(key), liveN: ls.length, liveR, liveAvgR, testN: row?.outSample.n ?? 0, testAvgR, vs };
  });
  live.sort((a, b) => b.liveN - a.liveN || a.key.localeCompare(b.key));

  // the list
  const start = x.chosenAtStart ? new Set(x.chosenAtStart) : null;
  const nowSet = new Set(x.chosen);
  const list = {
    now: [...x.chosen],
    added: start ? x.chosen.filter((k) => !start.has(k)) : [],
    removed: start ? [...start].filter((k) => !nowSet.has(k)) : [],
    proven: Object.entries(x.proven)
      .filter(([, ks]) => ks.length)
      .map(([pair, ks]) => ({ pair, keys: ks })),
  };

  // losses this week
  const lw = x.losses.filter((l) => l.closedAt >= weekStart);
  const causes = new Map<string, { n: number; usd: number }>();
  for (const l of lw) for (const c of l.causes) {
    const k = causes.get(c) ?? { n: 0, usd: 0 };
    k.n++;
    k.usd = r2(k.usd + l.usd);
    causes.set(c, k);
  }
  const losses = {
    n: lw.length,
    normal: lw.filter((l) => l.verdict === 'normal').length,
    avoidable: lw.filter((l) => l.verdict === 'avoidable').length,
    pending: lw.filter((l) => l.verdict === 'pending').length,
    usd: r2(lw.reduce((n, l) => n + l.usd, 0)),
    causes: [...causes].map(([cause, v]) => ({ cause, ...v })).sort((a, b) => a.usd - b.usd),
  };

  // held back — refusals made this week, per reason, with the lab's finished result
  const hb = new Map<string, { n: number; done: number; totalR: number }>();
  for (const s of x.shadow) {
    if (s.at < weekStart) continue;
    const k = hb.get(s.kind) ?? { n: 0, done: 0, totalR: 0 };
    k.n++;
    if (typeof s.r === 'number') {
      k.done++;
      k.totalR = r2(k.totalR + s.r);
    }
    hb.set(s.kind, k);
  }
  const heldBack = [...hb].map(([kind, v]) => ({ kind, label: SHORT[kind] ?? kind, ...v })).sort((a, b) => Math.abs(b.totalR) - Math.abs(a.totalR));

  // near misses: rows that made money on unseen data but aren't live, then single-market cells
  const liveKeys = new Set([...x.chosen, ...Object.values(x.proven).flat()]);
  const nearRows: NearMiss[] = x.rows
    .filter((r) => r.id !== 'random' && r.verdict !== 'edge' && !liveKeys.has(`${r.id}:${r.tf}`) && r.outSample.avgR > 0 && r.outSample.n >= 10)
    .map((r) => ({ key: `${r.id}:${r.tf}`, name: nameOf(`${r.id}:${r.tf}`), pair: null, n: r.outSample.n, avgR: r.outSample.avgR, pf: r.outSample.pf, missing: missingFor({ n: r.outSample.n, avgR: r.outSample.avgR, pf: r.outSample.pf, inAvgR: r.inSample.avgR, dsr: r.stats?.dsr ?? null }, false) }))
    .filter((m) => m.missing.length)
    .sort((a, b) => a.missing.length - b.missing.length || b.avgR * Math.sqrt(b.n) - a.avgR * Math.sqrt(a.n))
    .slice(0, 6);
  const nearCells: NearMiss[] = [];
  for (const r of x.rows) {
    if (r.id === 'random') continue;
    for (const c of r.markets ?? []) {
      if (c.n < 15 || !(c.avgR > 0.05) || (x.proven[c.pair] ?? []).includes(`${r.id}:${r.tf}`)) continue;
      const missing = missingFor({ n: c.n, avgR: c.avgR, pf: c.pf, inN: c.inN, inAvgR: c.inAvgR, mcP: c.mcP }, true);
      if (missing.length && missing.length <= 2) nearCells.push({ key: `${r.id}:${r.tf}`, name: nameOf(`${r.id}:${r.tf}`), pair: c.pair, n: c.n, avgR: c.avgR, pf: c.pf, missing });
    }
  }
  nearCells.sort((a, b) => a.missing.length - b.missing.length || b.avgR * Math.sqrt(b.n) - a.avgR * Math.sqrt(a.n));
  const nearMisses = [...nearRows, ...nearCells.slice(0, 6)];

  // Monday
  const weekAhead = x.events
    .filter((e) => e.impact === 'High' && e.t > x.now && e.t < x.now + 8 * 86_400_000 && (x.universe === 'fx' || e.ccy === 'USD'))
    .sort((a, b) => a.t - b.t)
    .slice(0, 12)
    .map((e) => ({ t: e.t, ccy: e.ccy, title: e.title }));
  const rd = x.ready;
  const liveCount = x.chosen.length + list.proven.reduce((n, p) => n + p.keys.length, 0);
  const checks = [
    { ok: rd.labRanAt !== null && x.now - rd.labRanAt < 2.5 * 3_600_000 && !rd.labError, text: rd.labError ? `the lab's last run failed: ${rd.labError}` : rd.labRanAt === null ? 'the lab has not run since the restart' : x.now - rd.labRanAt < 2.5 * 3_600_000 ? 'the lab re-tested every strategy in the last 2 hours' : `the lab last ran ${Math.round((x.now - rd.labRanAt) / 3_600_000)} h ago` },
    { ok: rd.staleMarkets.length === 0, text: rd.staleMarkets.length ? `prices lagging on ${rd.staleMarkets.join(', ')}` : 'every market has fresh prices' },
    { ok: liveCount > 0, text: liveCount ? `${liveCount} proven strategy × chart${liveCount === 1 ? '' : 's'} ready to trade` : 'nothing passes the strict test yet — it will wait until something does' },
    { ok: rd.equityUsd !== null, text: rd.equityUsd !== null ? `account readable ($${rd.equityUsd.toFixed(2)}, risk mode ${rd.riskMode})` : 'the bot account could not be read' },
    ...(x.universe === 'fx' ? [{ ok: rd.openPositions === 0, text: rd.openPositions ? `${rd.openPositions} trade${rd.openPositions === 1 ? '' : 's'} still open over the weekend` : 'no trades left open over the weekend' }] : []),
  ];
  const ready = { ok: checks.every((c) => c.ok || c.text.startsWith('nothing passes')), checks };

  // lessons — plain words, each tied to a number above
  const lessons: string[] = [];
  const desk = x.universe === 'fx' ? 'forex' : 'coin';
  if (money.trades) lessons.push(`This week the ${desk} bot closed ${money.trades} trade${money.trades === 1 ? '' : 's'} for ${usdTxt(money.pnlUsd)} (${money.winPct}% won)${money.prevPnlUsd !== null ? `, last week ${usdTxt(money.prevPnlUsd)}` : ''}.`);
  else lessons.push(`The ${desk} bot closed no trades this week.`);
  for (const l of live) {
    if (l.vs === 'worse') lessons.push(`${l.name} made ${l.liveAvgR}R a trade live (${l.liveN} trades) against ${l.testAvgR}R in the test — the restricted learner halves or drops it if that keeps up.`);
    if (l.vs === 'better') lessons.push(`${l.name} did better live (${l.liveAvgR}R a trade on ${l.liveN}) than tested (${l.testAvgR}R) — luck can do that on a few trades; size stays as tested.`);
  }
  if (losses.avoidable) lessons.push(`${losses.avoidable} of ${losses.n} losing trades were avoidable (${losses.causes.map((c) => `${c.cause} ×${c.n}`).join(', ')}); the matching rules are on.`);
  else if (losses.n) lessons.push(`All ${losses.n - losses.pending} graded losses this week were normal (the tested trade lost too) — the cost of trading, not a mistake.`);
  for (const h of heldBack) {
    if (h.done < 3 || Math.abs(h.totalR) < WEEKEND.heldBackR) continue;
    lessons.push(h.totalR > 0 ? `"${h.label}" held back ${h.done} finished trades that would have made +${h.totalR}R — evidence against that rule${h.done < 20 ? ' (too few trades to change it yet)' : ', worth a look'}.` : `"${h.label}" kept it out of ${h.done} trades that lost ${h.totalR}R — that rule earned its place this week.`);
  }
  if (list.added.length) lessons.push(`Earned a live place this week: ${list.added.map(nameOf).join(', ')}.`);
  if (list.removed.length) lessons.push(`Lost its live place this week: ${list.removed.map(nameOf).join(', ')} (open trades run out on their own stops).`);
  const nm = nearMisses[0];
  if (nm) lessons.push(`Closest to going live: ${nm.name}${nm.pair ? ` on ${nm.pair}` : ''} (${nm.n} unseen trades, ${nm.avgR}R a trade) — still needs ${nm.missing.join('; ')}.`);
  for (const r of x.rows) {
    if (!x.chosen.includes(`${r.id}:${r.tf}`) || !r.skip) continue;
    const parts = [...r.skip.sessions.map((s) => SESS[s] ?? String(s)), ...r.skip.pairs];
    if (parts.length) lessons.push(`${nameOf(`${r.id}:${r.tf}`)} skips ${parts.join(', ')} (it lost there before the test line).`);
  }
  if (!liveCount) lessons.push(`Nothing on the ${desk} desk passes the strict test right now — Monday it waits and keeps testing rather than trade on hope.`);

  const headline = !ready.ok
    ? `Not ready for Monday: ${checks.find((c) => !c.ok && !c.text.startsWith('nothing passes'))?.text}`
    : `${money.trades ? `Week ${usdTxt(money.pnlUsd)} on ${money.trades} trade${money.trades === 1 ? '' : 's'}` : 'No trades this week'} · ${liveCount ? `${liveCount} proven setup${liveCount === 1 ? '' : 's'} ready` : 'nothing proven yet — it waits'}${weekAhead.length ? ` · ${weekAhead.length} big news events ahead` : ''}`;

  return { at: x.now, universe: x.universe, week: monday, headline, money, live, list, losses, heldBack, nearMisses, monday: { events: weekAhead, riskMode: rd.riskMode }, ready, lessons };
}

/** Pure: the keys live at `t` from the chosen history (newest first, `{t, keys}`), null when it doesn't reach back. */
export function chosenAt(hist: ReadonlyArray<{ t: number; keys: string[] }>, t: number): string[] | null {
  const before = hist.filter((h) => h.t <= t).sort((a, b) => b.t - a.t)[0];
  return before ? before.keys : null;
}

/** Pure: the phone text for "ready for Monday". */
export function readyText(r: WeekendRecap): string {
  const desk = r.universe === 'fx' ? 'Forex bot' : 'Coin bot';
  if (!r.ready.ok) return `⚠️ ${desk} NOT ready for Monday — ${r.headline.replace(/^Not ready for Monday: /, '')}`;
  return `✅ ${desk} ready for Monday — ${r.headline}`;
}

// ---------- the AI review (display only) ----------

export interface WeekendAi {
  at: number;
  model: string;
  summary: string;
  wentWell: string[];
  wentWrong: string[];
  /** ideas for the lab to TEST (never applied by this) */
  ideas: Array<{ idea: string; test: string }>;
  watchMonday: string[];
}

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    wentWell: { type: 'array', items: { type: 'string' } },
    wentWrong: { type: 'array', items: { type: 'string' } },
    ideas: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { idea: { type: 'string' }, test: { type: 'string' } }, required: ['idea', 'test'] } },
    watchMonday: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'wentWell', 'wentWrong', 'ideas', 'watchMonday'],
};

const AI_SYSTEM = `You review one week of a paper-trading bot for its owner, who has some coding knowledge and wants plain words.
You get the week's recap as JSON: money, each live strategy's live R next to its tested R, losses graded normal / avoidable,
what each hold-back rule cost or saved (the lab's result for trades the bot refused), the strategies closest to passing the
strict test and what they miss, next week's big news, and a readiness checklist.
Rules: use only the numbers given; one week is a small sample, say so when a conclusion rests on few trades; never suggest
loosening the strict test, raising size or trading something that hasn't passed it; ideas must be things the lab can TEST
on its 70/30 split (a filter, an exit, a session, a market), each with how to test it. Short sentences. At most 4 items a list.`;

export function parseWeekendAi(text: string): Omit<WeekendAi, 'at' | 'model'> | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 4) : []);
    if (typeof o.summary !== 'string') return null;
    const ideas = Array.isArray(o.ideas) ? o.ideas.flatMap((i) => (i && typeof i === 'object' && typeof (i as { idea?: unknown }).idea === 'string' ? [{ idea: (i as { idea: string }).idea, test: String((i as { test?: unknown }).test ?? '') }] : [])).slice(0, 4) : [];
    return { summary: o.summary, wentWell: strs(o.wentWell), wentWrong: strs(o.wentWrong), ideas, watchMonday: strs(o.watchMonday) };
  } catch {
    return null;
  }
}

export interface WeekendStore {
  recap: WeekendRecap;
  ai: WeekendAi | null;
}

/** Reads what a desk needs for its recap (index.ts wires it to the lab, the account, the calendar). */
export type GatherRecap = (now: number) => Promise<RecapInput | null>;

export interface WeekendDeskDef {
  universe: 'fx' | 'crypto';
  /** Redis key prefix mapper (lab.k) */
  k: (key: string) => string;
  gather: GatherRecap;
}

/** The weekend job: every 15 minutes, per desk — recap while it's the weekend, the AI review, the Sunday push. */
export class WeekendReview {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly client: Anthropic | null;
  readonly model = process.env.AI_WEEKEND_MODEL || process.env.AI_MODEL || 'claude-sonnet-5-5';
  constructor(
    private readonly redis: Redis,
    private readonly desks: readonly WeekendDeskDef[],
    private readonly clock: (now: number) => MarketClock,
    private readonly notify: (universe: 'fx' | 'crypto', text: string, ok: boolean) => void,
    client?: Anthropic | null,
  ) {
    this.client = client !== undefined ? client : process.env.ANTHROPIC_API_KEY && process.env.AI_WEEKEND !== 'off' ? new Anthropic() : null;
  }
  start(): void {
    if (!WEEKEND.on) return;
    setTimeout(() => void this.tick().catch(() => undefined), 2 * 60_000);
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 15 * 60_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  async get(k: (key: string) => string): Promise<WeekendStore | null> {
    try {
      const raw = await this.redis.get(k('fx:weekend'));
      return raw ? (JSON.parse(raw) as WeekendStore) : null;
    } catch {
      return null;
    }
  }
  /** one pass over the desks; `force` = build now whatever the day (dashboard "Review now") */
  async tick(now = Date.now(), force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const clock = this.clock(now);
      for (const d of this.desks) {
        try {
          await this.desk(d, now, clock, force);
        } catch (err) {
          log.warn({ err: (err as Error).message, desk: d.universe }, 'weekend review failed');
        }
      }
    } finally {
      this.busy = false;
    }
  }
  private async desk(d: WeekendDeskDef, now: number, clock: MarketClock, force: boolean): Promise<void> {
    const weekend = isWeekendFor(d.universe, clock, now);
    if (!weekend && !force) return;
    const prev = await this.get(d.k);
    const fresh = prev && now - prev.recap.at < WEEKEND.everyHours * 3_600_000;
    let store = prev;
    if (!fresh || force) {
      const input = await d.gather(now);
      if (!input) return;
      const recap = buildRecap(input);
      const day = new Date(now).toISOString().slice(0, 10);
      const keepAi = prev?.ai && new Date(prev.ai.at).toISOString().slice(0, 10) === day ? prev.ai : null;
      const ai = keepAi ?? (WEEKEND.ai ? await this.review(recap, now) : null) ?? (prev?.ai && prev.recap.week === recap.week ? prev.ai : null);
      store = { recap, ai };
      await this.redis.set(d.k('fx:weekend'), JSON.stringify(store), 'EX', 14 * 86_400);
      await this.redis.multi().lpush(d.k('fx:weekend:hist'), JSON.stringify({ at: recap.at, week: recap.week, headline: recap.headline, lessons: recap.lessons })).ltrim(d.k('fx:weekend:hist'), 0, 11).exec();
      log.info({ desk: d.universe, headline: recap.headline }, 'weekend recap built');
    }
    // the Sunday push, once per weekend per desk, before forex opens
    if (store && !clock.open && clock.minutesToChange <= WEEKEND.readyPushMin) {
      const tag = new Date(now).toISOString().slice(0, 10);
      if ((await this.redis.set(d.k(`fx:readypush:${tag}`), '1', 'EX', 3 * 86_400, 'NX')) === 'OK') {
        // rebuild right before the push so the checklist is current
        const input = await d.gather(now);
        const recap = input ? buildRecap(input) : store.recap;
        if (input) await this.redis.set(d.k('fx:weekend'), JSON.stringify({ recap, ai: store.ai }), 'EX', 14 * 86_400);
        this.notify(d.universe, readyText(recap), recap.ready.ok);
      }
    }
  }
  /** one Claude review of the recap (null without a key, over budget, or on any failure) */
  private async review(recap: WeekendRecap, now: number): Promise<WeekendAi | null> {
    if (!this.client) return null;
    const day = new Date(now).toISOString().slice(0, 10);
    const spendKey = `fx:weekend:spend:${day}`;
    const spent = Number(await this.redis.get(spendKey).catch(() => '0')) || 0;
    if (spent >= WEEKEND.aiBudgetUsd) return null;
    const model = this.model;
    try {
      const fallback = /haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const };
      const res = await this.client.beta.messages.create({
        model,
        max_tokens: 3000,
        ...fallback,
        system: AI_SYSTEM,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content: `Desk: ${recap.universe === 'fx' ? 'forex' : 'crypto coins'}. Week recap:\n${JSON.stringify({ ...recap, money: { ...recap.money, byStrategy: recap.money.byStrategy.slice(0, 12) } })}` }],
      });
      const price = priceFor(model, res.usage.input_tokens);
      const cost = (res.usage.input_tokens * price.in + res.usage.output_tokens * price.out) / 1e6;
      await this.redis.multi().incrbyfloat(spendKey, cost).expire(spendKey, 3 * 86_400).incrbyfloat(`ai:spend:${day}`, cost).expire(`ai:spend:${day}`, 3 * 86_400).exec();
      if (res.stop_reason === 'refusal') return null;
      const v = parseWeekendAi(res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''));
      return v ? { ...v, at: now, model } : null;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'weekend AI review failed');
      return null;
    }
  }
}
