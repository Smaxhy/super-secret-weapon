/**
 * v20 Market desks — one desk (villager) per market, with its own strategy ranking, its own learning, and a daily
 * trade quota so every market keeps teaching the bot something.
 *
 * The idea (a bandit per market): each market has "arms" = strategy × chart rows that have a record on it. An arm's
 * score blends the lab's paper record on THAT market (the prior: the row's per-pair stats, shrunk toward 0 by 10
 * pretend break-even trades) with the bot's OWN closed trades on that market from its R ledger (counted double: they
 * are real fills at real spreads). An exploration bonus (UCB1 style, `DESK.explore · √(ln N / n)`) lifts arms the
 * desk has rarely tried, so "what works here" keeps being tested instead of frozen. The desk ranks its arms every
 * hour.
 *
 * The quota: when a market has not opened a trade today (trading day rolls at 22:00 UTC, like the daily bars) and a
 * strategy the bot does NOT normally trade fires on it, the desk takes its best-ranked firing arm as a LEARNING
 * trade: half the risk mode's base risk (`DESK.riskMult`), always a market entry (never a resting order), the judge
 * and conviction tiers skipped (a learning trade is the data), every other guard unchanged (news, clock, stale feeds,
 * cooldown, caps, currency cap, correlated risk, margin). Arms whose blended record is clearly negative
 * (`DESK.minScore`) are never picked — the quota buys information, not known losers. Pure; the lab applies it.
 */
import type { LabOpenTrade, BotLedgerRow, ClosedPractice, PracticePosition } from './practice';

export const DESK = {
  /** learning trades a desk may open per trading day when nothing else traded there */
  quotaPerDay: 1,
  /** a desk's learning trade risks this × the risk mode's base */
  riskMult: 0.5,
  /** pretend break-even trades mixed into every arm's prior (shrinkage) */
  priorN: 10,
  /** the bot's own fills count this many times a paper trade */
  ownWeight: 2,
  /** exploration bonus scale (R units) */
  explore: 0.35,
  /** an arm whose blended mean R is under this is never picked for a learning trade */
  minScore: -0.08,
  /** the bot's own ledger rows older than this are ignored by the desk */
  ownDays: 60,
  /** the trading day rolls here (UTC hour) — the same roll the daily bars use */
  dayRollUtcHour: 22,
  /** arms kept per desk in the report */
  maxArms: 8,
} as const;

export interface DeskArm {
  key: string;
  strategy: string;
  tf: string;
  /** lab paper record on this market (final variant, whole history) */
  prior: { n: number; totalR: number; pf: number | null };
  /** the bot's own closed trades here (last `ownDays`) */
  own: { n: number; totalR: number };
  /** blended mean R after shrinkage */
  mean: number;
  /** mean + exploration bonus — the desk ranks by this */
  score: number;
  /** the bot trades this row anyway (global chooser) */
  chosen: boolean;
}

export type DeskStatus = 'traded' | 'picked' | 'waiting' | 'idle';

export interface MarketDesk {
  id: string;
  arms: DeskArm[];
  tradesToday: number;
  quota: number;
  lastTradeAt: number | null;
  /** today's learning pick (set when the desk took a signal this run) */
  pick: { key: string; why: string } | null;
  status: DeskStatus;
  /** plain words */
  says: string;
}

export interface DeskRow {
  id: string;
  tf: string;
  pairs: Array<{ pair: string; n: number; pf: number | null; totalR: number }>;
}

export interface DeskInput {
  now: number;
  markets: string[];
  rows: DeskRow[];
  /** the bot's R ledger rows (ref = strategy:tf:pair:keyT) */
  ledger: BotLedgerRow[];
  positions: Pick<PracticePosition, 'pair' | 'openedAt'>[];
  closed: Pick<ClosedPractice, 'pair' | 'openedAt' | 'reason'>[];
  /** this run's fresh signals (every row's open trades) */
  open: Pick<LabOpenTrade, 'ref' | 'pair' | 'strategy' | 'tf' | 'chosen' | 'entryT'>[];
  chosen: Set<string>;
  /** learning trades a desk may take today (default `DESK.quotaPerDay`; 0 = the desks rank and study, never trade) */
  quota?: number;
}

const DAY = 86_400_000;
/** start of the trading day that contains `now` (22:00 UTC roll) */
export function dayStart(now: number, rollHour = DESK.dayRollUtcHour): number {
  const roll = rollHour * 3_600_000;
  return Math.floor((now - roll) / DAY) * DAY + roll;
}

const pairOfRef = (ref: string) => ref.split(':')[2] ?? '';

/** Rank every market's arms and pick today's learning trade where the quota is open. Pure. */
export function buildDesks(x: DeskInput): { desks: MarketDesk[]; picks: Map<string, { key: string; why: string; rank: number; of: number }> } {
  const quota = x.quota ?? DESK.quotaPerDay;
  const since = x.now - DESK.ownDays * DAY;
  const day0 = dayStart(x.now);
  // the bot's own record per market × arm (last ownDays, known R, no manual closes = why 5)
  const own = new Map<string, { n: number; totalR: number }>();
  for (const l of x.ledger) {
    if (l.closedAt < since || l.r === null || l.why === 5) continue;
    const k = `${pairOfRef(l.ref)}|${l.key}`;
    const o = own.get(k) ?? { n: 0, totalR: 0 };
    o.n += 1;
    o.totalR += Math.max(-3, Math.min(3, l.r));
    own.set(k, o);
  }
  const picks = new Map<string, { key: string; why: string; rank: number; of: number }>();
  const desks: MarketDesk[] = x.markets.map((id) => {
    // arms: every row with a record on this market
    const arms: DeskArm[] = [];
    let total = 0;
    for (const r of x.rows) {
      if (r.id === 'random') continue;
      const p = r.pairs.find((q) => q.pair === id);
      if (!p || p.n < 1) continue;
      const key = `${r.id}:${r.tf}`;
      const o = own.get(`${id}|${key}`) ?? { n: 0, totalR: 0 };
      const nEff = p.n + DESK.ownWeight * o.n;
      total += nEff;
      const mean = (p.totalR + DESK.ownWeight * o.totalR) / (nEff + DESK.priorN);
      arms.push({ key, strategy: r.id, tf: r.tf, prior: { n: p.n, totalR: Math.round(p.totalR * 100) / 100, pf: p.pf }, own: o, mean: Math.round(mean * 1000) / 1000, score: 0, chosen: x.chosen.has(key) });
    }
    for (const a of arms) {
      const nEff = a.prior.n + DESK.ownWeight * a.own.n;
      a.score = Math.round((a.mean + DESK.explore * Math.sqrt(Math.log(total + 1) / (nEff + 1))) * 1000) / 1000;
    }
    arms.sort((p, q) => q.score - p.score);
    // today's trades on this market (opened today, open or closed; weekend / partial rows are not trades)
    const openedToday = [...x.positions.filter((p) => p.pair === id && p.openedAt >= day0), ...x.closed.filter((c) => c.pair === id && c.openedAt >= day0 && c.reason !== 'weekend' && c.reason !== 'partial')];
    const lastTradeAt = [...x.positions.filter((p) => p.pair === id), ...x.closed.filter((c) => c.pair === id && c.reason !== 'weekend' && c.reason !== 'partial')].reduce<number | null>((m, p) => (m === null || p.openedAt > m ? p.openedAt : m), null);
    const tradesToday = openedToday.length;
    let pick: MarketDesk['pick'] = null;
    let status: DeskStatus = tradesToday > 0 ? 'traded' : arms.length ? 'waiting' : 'idle';
    if (quota > 0 && tradesToday < quota && arms.length) {
      // signals firing here now from arms the bot does NOT already trade, fresh today, best score first
      const firing = x.open.filter((t) => t.pair === id && !t.chosen && t.entryT >= day0);
      const rank = new Map(arms.map((a, i) => [a.key, i]));
      const cand = firing
        .map((t) => ({ t, arm: arms.find((a) => a.key === `${t.strategy}:${t.tf}`) ?? null }))
        .filter((c): c is { t: (typeof firing)[number]; arm: DeskArm } => !!c.arm && c.arm.mean >= DESK.minScore)
        .sort((p, q) => q.arm.score - p.arm.score)[0];
      if (cand) {
        const r = (rank.get(cand.arm.key) ?? 0) + 1;
        const why = `${id} had no trade today: its desk takes ${cand.arm.strategy} (${cand.arm.tf}), ranked ${r} of ${arms.length} here (mean ${cand.arm.mean >= 0 ? '+' : ''}${cand.arm.mean.toFixed(2)}R on ${cand.arm.prior.n} paper + ${cand.arm.own.n} own trades), at half size to learn`;
        pick = { key: cand.arm.key, why };
        picks.set(cand.t.ref, { key: cand.arm.key, why, rank: r, of: arms.length });
        status = 'picked';
      }
    }
    const top = arms[0];
    const says =
      status === 'traded'
        ? `traded today (${tradesToday}) · best here: ${top ? `${top.strategy} ${top.tf}` : '—'}`
        : status === 'picked'
          ? `taking ${pick!.key.replace(':', ' ')} as today's learning trade`
          : status === 'waiting'
            ? quota > 0
              ? `no trade yet today · waiting for ${top ? `${top.strategy} ${top.tf}` : 'a setup'}${arms.length > 1 ? ` or ${arms.length - 1} others` : ''}`
              : `study only · best here: ${top ? `${top.strategy} ${top.tf}` : '—'}${top?.chosen ? ' (the bot trades it)' : ' (not proven — not traded)'}`
            : 'no strategy has a record here yet';
    return { id, arms: arms.slice(0, DESK.maxArms), tradesToday, quota, lastTradeAt, pick, status, says };
  });
  return { desks, picks };
}

/** Mark the desks' picks on this run's lab trades: chosen, half size, market entry, judge / conviction skipped. Mutates. */
export function applyDesks(trades: LabOpenTrade[], picks: ReturnType<typeof buildDesks>['picks']): number {
  let n = 0;
  for (const t of trades) {
    const p = picks.get(t.ref);
    if (!p) continue;
    t.chosen = true;
    t.desk = { rank: p.rank, of: p.of, why: p.why };
    t.sizeF = DESK.riskMult;
    t.order = null;
    t.conviction = null;
    t.sniper = null;
    n += 1;
  }
  return n;
}

/** one line for the hub: how many desks traded / are waiting */
export function desksSummary(desks: MarketDesk[]): string {
  const traded = desks.filter((d) => d.status === 'traded').length;
  const picked = desks.filter((d) => d.status === 'picked').length;
  const waiting = desks.filter((d) => d.status === 'waiting').length;
  const study = desks.length > 0 && desks.every((d) => d.quota === 0);
  return `${traded} of ${desks.length} markets traded today${picked ? ` · ${picked} taking a learning trade now` : ''}${waiting ? ` · ${waiting} waiting for a ${study ? 'proven ' : ''}setup` : ''}${study ? ' · desks study only' : ''}`;
}
