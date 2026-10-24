/**
 * v19.4 "Why no trades?" — one plain-words verdict for the forex bot, from what it already records.
 *
 * Pure. Reads the check timeline (RunNote), the bot log (every reason it waited or skipped, with time), the last
 * sync report per chart, the chosen list, the account (last trade), the market clock, data ages and the lab's
 * last error, and answers: how long since the bot last opened a trade, what fired meanwhile, where the signals
 * went, and the ONE thing that explains most of it. The control room and the Today card show it.
 */
import type { RunNote } from './lab';
import type { SyncReport } from './practice';
import type { DataAge } from './freshness';
import { staleReason } from './freshness';

export type ReasonKind =
  | 'not_chosen'
  | 'cooldown'
  | 'caps'
  | 'day_cap'
  | 'judge_missing'
  | 'judge_no'
  | 'agree'
  | 'market_rec'
  | 'solo'
  | 'check_data'
  | 'stale_feed'
  | 'clock'
  | 'news'
  | 'shock'
  | 'late'
  | 'ccy_cap'
  | 'heat'
  | 'margin'
  | 'resting'
  | 'streak'
  | 'doubled'
  | 'other';

const LABEL: Record<ReasonKind, string> = {
  not_chosen: 'the signal came from a strategy the bot does not trade (no edge on unseen data)',
  cooldown: 'it had just closed a trade there (cooling off)',
  caps: 'its slots were full (per strategy, per chart or in total)',
  day_cap: 'the daily trade limit was reached',
  judge_missing: 'the signal judge had a reading missing (a feed is down) — it waits rather than trade blind',
  judge_no: 'the signal judge scored the setup too low',
  agree: 'too few market checks (strength, bigger charts, mood) stood behind the setup',
  market_rec: 'the strategy has no winning tested record on that market',
  solo: 'a Fibonacci signal came alone (it needs a second setup the same way)',
  check_data: 'a check the strategy was tested with had no data (feed missing)',
  stale_feed: 'the price feed was lagging (candles behind) — no new trades on that market',
  clock: 'the market clock (closed, rollover, weekly open / close)',
  news: 'news, a speech or a holiday on one of the currencies',
  shock: 'a price shock in the last 15 minutes',
  late: 'the price had already run past the entry, stop or target',
  ccy_cap: 'too much of the account already rode on that currency',
  heat: 'correlated risk was full',
  margin: 'not enough free margin',
  resting: 'it placed a resting pullback / limit order instead of buying at market (the entry lab found that pays better) — it only becomes a trade if the price comes back to it before the order expires',
  streak: 'a losing streak (4 bot losses in a row) — it pauses a few hours, then trades again at half size until a win',
  doubled: 'it was already in the same direction on that market (one bet per market and direction)',
  other: 'another check',
};

/** Which bucket a wait / skip text belongs to. Exported for tests. */
export function classify(why: string): ReasonKind {
  const w = why.toLowerCase();
  if (w.includes('daily limit reached')) return 'day_cap';
  if (w.includes('losses in a row')) return 'streak';
  if (w.includes('one bet per market')) return 'doubled';
  if (w.includes('cooling off')) return 'cooldown';
  if (w.includes('slots are full') || w.includes('trades open')) return 'caps';
  if (w.includes('signal judge') && w.includes('missing')) return 'judge_missing';
  if (w.includes('market checks agree')) return 'agree';
  if (w.includes('record on this market')) return 'market_rec';
  if (w.includes('waits for a second setup')) return 'solo';
  if (w.includes('signal judge')) return 'judge_no';
  if (w.includes('check has no data') || w.includes('feed missing')) return 'check_data';
  if (w.includes('candles behind') || w.includes('price data for') || w.includes('feed is lagging') || w.includes('no fresh')) return 'stale_feed';
  if (w.includes('market closed') || w.includes('weekly close') || w.includes('rollover') || w.includes('week just opened')) return 'clock';
  if (w.includes('news') || w.includes('speech') || w.includes('holiday') || w.includes('headline') || w.includes('calendar')) return 'news';
  if (w.includes('price shock')) return 'shock';
  if (w.includes('past its') || w.includes('chasing')) return 'late';
  if (w.includes('riding on')) return 'ccy_cap';
  if (w.includes('correlated risk')) return 'heat';
  if (w.includes('free margin')) return 'margin';
  return 'other';
}

export interface WhyInput {
  now: number;
  runs: RunNote[];
  log: Array<{ t: number; e: string }>;
  lastSync: Record<string, SyncReport>;
  chosen: string[];
  /** bot account: when it last opened anything, what is open / resting now */
  lastOpenedAt: number | null;
  openNow: number;
  ordersNow: number;
  clock: { open: boolean; noNewTrades: boolean; rollover?: boolean; sinceOpenMin?: number; minutesToChange?: number };
  dataAge: Record<string, DataAge>;
  labError: { t: number; msg: string } | null;
  /** hours of history to read (default 24) */
  hours?: number;
}

export interface WhyReport {
  at: number;
  /** resting orders in the window: placed / filled / expired unfilled / cancelled */
  orders: { placed: number; filled: number; expired: number; cancelled: number };
  /** hours since the bot last opened a trade or order (null = never) */
  hoursSinceOpen: number | null;
  openNow: number;
  ordersNow: number;
  marketOpen: boolean;
  window: { hours: number; checks: number; signals: number; chosen: number; opened: number; skipped: number; waits: number; lastCheckAt: number | null };
  reasons: Array<{ kind: ReasonKind; label: string; n: number; example: string }>;
  /** markets with lagging / missing candles right now */
  staleMarkets: string[];
  /** the one line that explains most of it */
  verdict: string;
  /** what would change it, in words */
  hint: string | null;
  /** quiet = no trade for 3 h+ while the market was open (the cards show the verdict in amber) */
  quiet: boolean;
}

const H = 3_600_000;

/** Pure. Builds the report. */
export function whyNoTrades(x: WhyInput): WhyReport {
  const hours = x.hours ?? 24;
  const since = x.now - hours * H;
  const runs = x.runs.filter((r) => r.t >= since);
  const window = runs.reduce(
    (a, r) => ({ ...a, checks: a.checks + 1, signals: a.signals + r.signals, chosen: a.chosen + r.chosen, opened: a.opened + r.opened, skipped: a.skipped + r.skipped, waits: a.waits + r.waits, lastCheckAt: Math.max(a.lastCheckAt ?? 0, r.t) }),
    { hours, checks: 0, signals: 0, chosen: 0, opened: 0, skipped: 0, waits: 0, lastCheckAt: null as number | null },
  );
  // reasons: the bot log (one line per reason per check) + the newest sync report per chart (unlogged repeats)
  const counts = new Map<ReasonKind, { n: number; example: string }>();
  const add = (kind: ReasonKind, example: string) => {
    const c = counts.get(kind);
    if (c) c.n += 1;
    else counts.set(kind, { n: 1, example });
  };
  let placed = 0;
  let expired = 0;
  let cancelled = 0;
  let filled = 0;
  for (const l of x.log) {
    if (l.t < since) continue;
    const e = l.e;
    if (/^placed a (pullback|limit) order/.test(e)) { placed += 1; add('resting', e); continue; }
    if (/limit order expired unfilled/.test(e)) { expired += 1; continue; }
    if (/^cancelled .*limit order/.test(e)) { cancelled += 1; continue; }
    if (/^filled (long|short) /.test(e)) { filled += 1; continue; }
    if (!/^(waiting on|waited on|skipped) /.test(e)) continue;
    add(classify(e), e);
  }
  for (const s of Object.values(x.lastSync)) {
    if (!s || s.at < since) continue;
    for (const r of [...s.skipped, ...s.waits]) add(classify(r.why), `${r.pair} (${r.strategy}): ${r.why}`);
  }
  if (window.signals > window.chosen) add('not_chosen', `${window.signals - window.chosen} of ${window.signals} signals came from strategies it does not trade`);
  const reasons = [...counts.entries()].map(([kind, c]) => ({ kind, label: LABEL[kind], n: kind === 'not_chosen' ? window.signals - window.chosen : c.n, example: c.example })).sort((a, b) => (a.kind === 'not_chosen' ? 1 : 0) - (b.kind === 'not_chosen' ? 1 : 0) || b.n - a.n);
  const staleMarkets = Object.values(x.dataAge).filter((a) => a && (a.tf === '1h' || a.tf === '4h') && staleReason(a, x.now)).map((a) => a.id);

  const hoursSinceOpen = x.lastOpenedAt ? (x.now - x.lastOpenedAt) / H : null;
  const quiet = x.clock.open && (hoursSinceOpen === null || hoursSinceOpen >= 3);
  const ago = hoursSinceOpen === null ? 'never' : hoursSinceOpen < 1 ? `${Math.round(hoursSinceOpen * 60)} min ago` : `${hoursSinceOpen.toFixed(hoursSinceOpen < 10 ? 1 : 0)} h ago`;
  const head = `Last trade opened: ${ago}${x.openNow ? ` · ${x.openNow} open now` : ''}${x.ordersNow ? ` · ${x.ordersNow} order${x.ordersNow === 1 ? '' : 's'} waiting to fill` : ''}.`;

  let verdict: string;
  let hint: string | null = null;
  const chosenN = x.chosen.length;
  if (x.labError && (window.lastCheckAt === null || x.labError.t > window.lastCheckAt)) {
    verdict = `${head} The hourly check is FAILING: ${x.labError.msg}`;
    hint = 'No check = no new trades. Read Setup → Data feeds and the bot log; the Today card shows the error line.';
  } else if (window.lastCheckAt === null || x.now - window.lastCheckAt > 2.5 * H) {
    verdict = `${head} The hourly check has not run for ${window.lastCheckAt === null ? `${hours}+ h` : `${((x.now - window.lastCheckAt) / H).toFixed(1)} h`}.`;
    hint = 'The lab is stuck or the bot restarted and has not finished its first look. If it stays like this, restart the bot (Controls → System).';
  } else if (!x.clock.open) {
    verdict = `${head} The forex market is closed${x.clock.minutesToChange ? ` — it opens in ${Math.round(x.clock.minutesToChange / 60)} h` : ''}.`;
  } else if (chosenN === 0) {
    verdict = `${head} The bot has NO strategies to trade: nothing passed the unseen-data test and nothing is always-on right now.`;
    hint = 'Lab → the playbook shows every verdict. It trades again when a strategy earns Edge / Maybe, or the weekly picker switches on.';
  } else if (window.signals === 0) {
    verdict = `${head} In the last ${hours} h no strategy fired at all on the hourly / 4-hour charts (${window.checks} checks).`;
    hint = 'Quiet markets: the rules wait for a setup. Nothing is wrong unless the price feeds show as stale.';
  } else if (window.chosen === 0) {
    verdict = `${head} ${window.signals} signal${window.signals === 1 ? '' : 's'} fired in ${hours} h, but none came from the ${chosenN} strateg${chosenN === 1 ? 'y' : 'ies'} the bot trades.`;
    hint = 'The firing rules have no proven edge, so it lets them pass. More strategies qualify as the paper record grows (Lab → the playbook).';
  } else if (window.opened === 0 && placed > 0) {
    verdict = `${head} ${window.chosen} tradeable signal${window.chosen === 1 ? '' : 's'} in ${hours} h became ${placed} resting order${placed === 1 ? '' : 's'} (pullback / limit entries), not market buys: ${filled} filled, ${expired} expired unfilled, ${cancelled} cancelled, ${x.ordersNow} still waiting.`;
    hint = 'The entry lab picked "wait for a pullback" for these strategies because it paid more per signal in the past — the cost is signals that never come back. Lab → "Does entry timing help?" shows the trade-off; the strategy row badge shows its way in.';
  } else {
    const top = reasons.find((r) => r.kind !== 'not_chosen');
    if (top) {
      verdict = `${head} ${window.chosen} tradeable signal${window.chosen === 1 ? '' : 's'} in ${hours} h, ${window.opened} opened. Main reason it held back: ${top.label} (${top.n}×).`;
      hint = HINT[top.kind] ?? null;
    } else {
      verdict = `${head} ${window.chosen} tradeable signal${window.chosen === 1 ? '' : 's'} in ${hours} h, ${window.opened} opened.`;
    }
  }
  if (staleMarkets.length && !verdict.includes('stale')) verdict += ` Price feed lagging on ${staleMarkets.length} market${staleMarkets.length === 1 ? '' : 's'} (${staleMarkets.slice(0, 4).join(', ')}${staleMarkets.length > 4 ? '…' : ''}).`;
  return { at: x.now, orders: { placed, filled, expired, cancelled }, hoursSinceOpen, openNow: x.openNow, ordersNow: x.ordersNow, marketOpen: x.clock.open, window, reasons, staleMarkets, verdict, hint, quiet };
}

const HINT: Partial<Record<ReasonKind, string>> = {
  judge_missing: 'A feed the judge learned from is down (Setup → Data feeds: CFTC / BIS / Dukascopy). Trades resume when it is back — or switch the judge off in the Lab.',
  check_data: 'A filter input is missing (Setup → Data feeds). The row trades again when the feed is back.',
  stale_feed: 'Yahoo candles are behind. Setup → Data feeds shows the ages; Dukascopy fills currency pairs when it can reach the host.',
  judge_no: 'Working as designed: the judge only lets the better-looking setups through.',
  agree: 'Working as designed (strict mode): a trade needs at least 1 of the market checks (strength, 4-hour trend, daily trend, mood) on its side. The shadow book on the Trades page shows what the held-back ones did.',
  market_rec: 'Working as designed: a strategy stays off a market where its own tested record there is a losing one (12+ trades, profit factor under 0.9).',
  solo: 'Working as designed (your rule): Fibonacci only trades next to another setup the same way on that market.',
  caps: 'Working as designed: raise the risk mode (Risk desk) for more slots.',
  day_cap: 'Working as designed (your rule): at most 10 new trades a day per bot, the best-tested signals first. Resets at 22:00 UTC.',
  news: 'Working as designed: it skips the half hour around high-impact news.',
  late: 'The lab filled a bar earlier than the bot saw the price; nothing to fix unless it repeats on every signal.',
  ccy_cap: 'Working as designed: one bet per currency. A higher risk mode raises the cap.',
  clock: 'Working as designed: no new trades in the rollover, the first 2 h of the week or the last 2 h.',
  cooldown: 'Working as designed: 3 candles of cooling off after a trade on the same market.',
};
