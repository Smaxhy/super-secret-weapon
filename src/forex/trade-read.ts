/**
 * v17.14 the live read of an open trade (owner: "an active diagnosis of what the goal of the trade is … actively
 * analyses the price action"). Rule-based and free, worked out again on every request from the newest 1-minute candles:
 * the goal in plain words, how far along it is, how the price moved in the last 5 / 15 / 60 minutes (pips its way or
 * against it), the best price since the entry and how much it gave back, the profit lock, the pace to the target,
 * whether the market still looks like the reason the trade was taken (the trend on its chart, the level it faded), the
 * nearest level ahead / behind, news coming up, and one status.
 * DESCRIPTIVE ONLY: none of it is a tested rule — nothing here closes or changes a trade; the exits stay the tested
 * ones. Pure.
 */

export type ReadStatus = 'closing' | 'near_target' | 'near_stop' | 'pressure' | 'locked' | 'early' | 'stalling' | 'on_track' | 'holding';

export const READ = {
  /** a trade younger than this is "just opened" */
  earlyMin: 5,
  /** this share of the way to the target → "almost there" */
  nearTarget: 0.8,
  /** this share of the way from the entry to a losing-side stop → "close to the stop" */
  nearStop: 0.75,
  /** under water and the last 15 minutes moved against it by this share of the hourly range (or of the stop distance) */
  pressureAtr: 0.35,
  pressureStop: 0.3,
  /** no new best price for max(this, a quarter of the usual hold) while less than half way → "stalling" */
  stallMin: 15,
  /** levels within this many hourly ranges of the price are mentioned */
  levelAtr: 1.5,
  /** news this close is mentioned */
  newsMin: 120,
};

/** the usual hold when the strategy sets no time exit (minutes, by chart) */
const HOLD_MIN: Record<string, number> = { '1m': 30, '15m': 240, '1h': 1_440, '4h': 5_760 };
const TF_MIN: Record<string, number> = { '1m': 1, '15m': 15, '1h': 60, '4h': 240 };

export interface ReadPos {
  id: string;
  pair: string;
  side: 1 | -1;
  entry: number;
  /** the exit-side price now (bid for a long, ask for a short) */
  px: number;
  stop: number | null;
  target: number | null;
  openedAt: number;
  strategy?: string;
  tf?: string;
  maxBars?: number | null;
  lock?: { at: number; to: number; gap: number } | null;
  locked?: boolean;
  tpHit?: boolean;
  closePending?: { reason: string; at: number } | null;
}

export interface ReadMarket {
  /** average hourly range in pips */
  atrPips?: number;
  /** trend on the 1h / 4h / daily chart (+1 up, −1 down, 0 none) */
  mtf?: { h1: number; h4: number; d1: number };
  rsi?: number;
  levels?: ReadonlyArray<{ kind: 'support' | 'resistance'; price: number; touches: number }>;
  lines?: ReadonlyArray<{ kind: 'support' | 'resistance'; pNow: number; touches: number; broken: boolean }>;
  prevDay?: { h: number; l: number } | null;
}

export interface ReadInput {
  pos: ReadPos;
  /** 1-minute candles (t, h, l, c[, o]) of mid prices, oldest first */
  bars: ReadonlyArray<readonly [number, number, number, number, number?]>;
  pip: number;
  digits: number;
  label: string;
  now: number;
  strategy?: { name: string; desc: string; style: string } | null;
  market?: ReadMarket | null;
  news?: ReadonlyArray<{ t: number; ccy: string; title: string; impact: string }>;
}

export interface TradeRead {
  id: string;
  status: ReadStatus;
  label: string;
  /** one short sentence: what the trade is trying to do */
  goal: string;
  /** why the strategy took it (its rule in words) */
  why: string | null;
  /** everything in pips from the entry, + = the trade's way */
  pips: { now: number; target: number | null; stop: number | null; lockAt: number | null; best: number | null; worst: number | null };
  /** 0 = entry, 100 = target (negative = toward the stop, −100 = at a losing-side stop) */
  progressPct: number | null;
  /** price moves over the last 5 / 15 / 60 minutes, pips its way (+) or against it (−) */
  move: { m5: number | null; m15: number | null; m60: number | null };
  /** minutes since the best price (null: unknown) */
  sinceBestMin: number | null;
  /** at the last hour's pace, minutes to the target (null: not moving its way / no target) */
  etaMin: number | null;
  /** the market still looks like the reason it was taken (null: nothing to check) */
  thesisOk: boolean | null;
  lines: string[];
  ageMin: number;
}

const LABELS: Record<ReadStatus, string> = {
  closing: 'Closing at the next price',
  near_target: 'Almost at the target',
  near_stop: 'Close to the stop',
  pressure: 'Under pressure',
  locked: 'Profit locked',
  early: 'Just opened',
  stalling: 'Stalling',
  on_track: 'On track',
  holding: 'A little under water',
};
export const statusLabel = (s: ReadStatus) => LABELS[s];

const r1 = (x: number) => Math.round(x * 10) / 10;
/** pips in words: one decimal under 10, whole above */
export const pipTxt = (x: number) => {
  const a = Math.abs(x);
  return a < 10 ? a.toFixed(1).replace(/\.0$/, '') : String(Math.round(a));
};
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${pipTxt(x)}`;
export const minTxt = (m: number) => {
  if (m < 1) return 'under a minute';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(m / 1440)} days`;
  const mm = Math.round(m - h * 60);
  return mm ? `${h} h ${mm} min` : `${h} h`;
};

/** the newest close at or before `t` (null when the candles don't reach back that far) */
function closeAt(bars: ReadInput['bars'], t: number): number | null {
  if (!bars.length || bars[0]![0] > t) return null;
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i]![0] <= t) return bars[i]![3];
  return null;
}

/** The live read of one open trade. Pure. */
export function liveRead(inp: ReadInput): TradeRead {
  const { pos: p, bars, pip, now } = inp;
  const s = p.side;
  const fmt = (x: number) => x.toFixed(inp.digits);
  const pipsOf = (price: number) => ((price - p.entry) * s) / pip;
  const ageMin = Math.max(0, (now - p.openedAt) / 60_000);
  const nowPips = pipsOf(p.px);
  const targetPips = p.target !== null && Number.isFinite(p.target) ? pipsOf(p.target) : null;
  const stopPips = p.stop !== null && Number.isFinite(p.stop) ? pipsOf(p.stop) : null;
  const lockAtPips = p.lock && !p.locked ? pipsOf(p.lock.at) : null;

  // moves over the last 5 / 15 / 60 minutes (mid candles), the trade's way +
  const last = bars.length ? bars[bars.length - 1]! : null;
  const moveOver = (min: number) => {
    if (!last) return null;
    const c0 = closeAt(bars, last[0] - min * 60_000);
    return c0 === null ? null : r1(((last[3] - c0) * s) / pip);
  };
  const move = { m5: moveOver(5), m15: moveOver(15), m60: moveOver(60) };

  // the best and worst prices since the entry (exit side ≈ mid; the candles may start after the entry)
  const openMin = Math.floor(p.openedAt / 60_000) * 60_000;
  let best: number | null = null;
  let bestT: number | null = null;
  let worst: number | null = null;
  for (const b of bars) {
    if (b[0] < openMin) continue;
    const fav = s === 1 ? b[1] : b[2];
    const adv = s === 1 ? b[2] : b[1];
    const fp = pipsOf(fav);
    if (best === null || fp > best) {
      best = fp;
      bestT = b[0] + 60_000;
    }
    const ap = pipsOf(adv);
    if (worst === null || ap < worst) worst = ap;
  }
  if (best === null || nowPips > best) {
    best = nowPips;
    bestT = now;
  }
  if (worst === null || nowPips < worst) worst = nowPips;
  const covered = bars.length > 0 && bars[0]![0] <= openMin + 60_000;
  // candles that start after the entry: a best on their first candle may be older — its age is unknown
  const bestKnown = covered || !bars.length || bestT !== bars[0]![0] + 60_000;
  const sinceBestMin = bestT !== null ? Math.max(0, (now - bestT) / 60_000) : null;

  // progress: 0 = entry, 100 = target, −100 = a stop on the losing side
  let progressPct: number | null = null;
  if (nowPips >= 0 && targetPips !== null && targetPips > 0) progressPct = Math.round((nowPips / targetPips) * 100);
  else if (nowPips < 0 && stopPips !== null && stopPips < 0) progressPct = -Math.round((nowPips / stopPips) * 100);
  else if (nowPips < 0 && targetPips !== null && targetPips > 0) progressPct = Math.round((nowPips / targetPips) * 100);
  const toTargetFrac = targetPips !== null && targetPips > 0 ? nowPips / targetPips : null;
  const toStopFrac = stopPips !== null && stopPips < 0 ? nowPips / stopPips : null;
  const stopInProfit = stopPips !== null && stopPips > 0;

  const tf = p.tf ?? '';
  const holdMin = p.maxBars && TF_MIN[tf] ? p.maxBars * TF_MIN[tf]! : HOLD_MIN[tf] ?? HOLD_MIN['1h']!;
  const pace = move.m60 !== null && move.m60 > 0 ? move.m60 : null;
  const etaMin = pace !== null && targetPips !== null && targetPips > nowPips ? Math.round(((targetPips - nowPips) / pace) * 60) : null;

  // does the market still look like the reason it was taken?
  const style = inp.strategy?.style ?? 'neutral';
  const m = inp.market ?? null;
  let thesisOk: boolean | null = null;
  let thesis: string | null = null;
  const chartKey = tf === '4h' ? 'h4' : 'h1';
  const chartName = tf === '4h' ? '4-hour' : 'hourly';
  if ((style === 'trend' || style === 'pullback') && m?.mtf) {
    const tr = m.mtf[chartKey];
    if (tr === s) {
      thesisOk = true;
      thesis = `The ${chartName} trend still points its way${m.mtf.d1 === s ? ', and so does the daily' : m.mtf.d1 === -s ? ' (the daily points the other way)' : ''}.`;
    } else if (tr === -s) {
      thesisOk = false;
      thesis = `The ${chartName} trend now points against it — the reason for the trade is weaker.`;
    } else thesis = `No clear ${chartName} trend right now — it needs the move to carry on by itself.`;
  } else if (style === 'revert') {
    const stopDist = stopPips !== null && stopPips < 0 ? -stopPips : (m?.atrPips ?? 0);
    if (nowPips < 0 && move.m15 !== null && move.m15 < 0 && stopDist > 0 && -nowPips > 0.5 * stopDist) {
      thesisOk = false;
      thesis = 'The move it bet against is still running — no turn yet.';
    } else if (nowPips > 0 || (move.m15 !== null && move.m15 > 0)) {
      thesisOk = true;
      thesis = 'The price is turning back the way it bet — the snap-back it waits for has started.';
    } else thesis = 'It waits for the price to turn back; no clear turn yet.';
  }

  // the nearest level ahead (in the trade's way) and behind (between the price and the stop)
  const lv: Array<{ price: number; name: string }> = [];
  for (const l of m?.levels ?? []) lv.push({ price: l.price, name: `${l.kind} at ${fmt(l.price)} (${l.touches} touches)` });
  for (const l of m?.lines ?? []) if (!l.broken) lv.push({ price: l.pNow, name: `the ${l.kind === 'support' ? 'rising support' : 'falling resistance'} line (${fmt(l.pNow)})` });
  if (m?.prevDay) {
    lv.push({ price: m.prevDay.h, name: `yesterday's high (${fmt(m.prevDay.h)})` });
    lv.push({ price: m.prevDay.l, name: `yesterday's low (${fmt(m.prevDay.l)})` });
  }
  const reach = (m?.atrPips ?? 0) * READ.levelAtr;
  let ahead: { d: number; name: string } | null = null;
  let behind: { d: number; name: string } | null = null;
  for (const l of lv) {
    const d = pipsOf(l.price) - nowPips;
    if (reach <= 0 || Math.abs(d) > reach || Math.abs(d) < 0.5) continue;
    if (d > 0 && (targetPips === null || pipsOf(l.price) < targetPips) && (!ahead || d < ahead.d)) ahead = { d, name: l.name };
    if (d < 0 && (stopPips === null || pipsOf(l.price) > stopPips) && (!behind || -d < behind.d)) behind = { d: -d, name: l.name };
  }

  const news = (inp.news ?? []).filter((e) => e.impact !== 'Holiday' && e.t >= now - 15 * 60_000 && e.t <= now + READ.newsMin * 60_000).sort((a, b) => a.t - b.t)[0] ?? null;

  // one status (the first that applies)
  const scale = Math.max(m?.atrPips ? READ.pressureAtr * m.atrPips : 0, stopPips !== null && stopPips < 0 ? READ.pressureStop * -stopPips : 0);
  let status: ReadStatus;
  if (p.closePending) status = 'closing';
  else if (toTargetFrac !== null && toTargetFrac >= READ.nearTarget) status = 'near_target';
  else if (toStopFrac !== null && toStopFrac >= READ.nearStop) status = 'near_stop';
  else if (nowPips < 0 && ((scale > 0 && move.m15 !== null && move.m15 <= -scale) || thesisOk === false)) status = 'pressure';
  else if (p.locked || stopInProfit) status = 'locked';
  else if (ageMin < READ.earlyMin) status = 'early';
  else if (sinceBestMin !== null && sinceBestMin >= Math.max(READ.stallMin, holdMin / 4) && (toTargetFrac === null || toTargetFrac < 0.5) && bestKnown) status = 'stalling';
  else if (nowPips >= 0 || (move.m15 !== null && move.m15 > 0)) status = 'on_track';
  else status = 'holding';

  // the goal in one sentence
  const what = `${s === 1 ? 'Bought' : 'Sold'} ${inp.label}${inp.strategy ? ` on "${inp.strategy.name}"` : ''}${tf ? ` (${tf} chart)` : ''}`;
  const aim = targetPips !== null && targetPips > 0 ? `aims for ${fmt(p.target!)} (${signed(targetPips)} pips)` : p.tpHit ? 'passed its target and now rides a trailing stop' : 'has no fixed target — it rides a trailing stop';
  const out =
    stopPips === null ? 'no stop' : stopInProfit ? `the stop at ${fmt(p.stop!)} already keeps ${signed(stopPips)} pips` : stopPips === 0 ? `the stop sits at the entry (${fmt(p.stop!)})` : `gives up at ${fmt(p.stop!)} (${signed(stopPips)} pips)`;
  const goal = `${what}: ${aim}; ${out}.`;

  const lines: string[] = [];
  // where it is
  if (nowPips >= 0) lines.push(`${nowPips > 0 ? `Up ${pipTxt(nowPips)} pips` : 'Flat'}${toTargetFrac !== null ? ` — ${Math.round(toTargetFrac * 100)}% of the way to the target` : ''}.`);
  else lines.push(`Down ${pipTxt(nowPips)} pips${toStopFrac !== null ? ` — ${Math.round(toStopFrac * 100)}% of the way to the stop` : ''}.`);
  // the moves
  const mv: string[] = [];
  if (move.m5 !== null) mv.push(`${signed(move.m5)} in 5 min`);
  if (move.m15 !== null) mv.push(`${signed(move.m15)} in 15 min`);
  if (move.m60 !== null) mv.push(`${signed(move.m60)} in the last hour`);
  if (mv.length) {
    const key = move.m15 ?? move.m5 ?? move.m60 ?? 0;
    lines.push(`${key > 0 ? 'Moving its way' : key < 0 ? 'Moving against it' : 'Going sideways'}: ${mv.join(', ')} (pips, + = its way).`);
  }
  // best so far
  if (best !== null && best > 0.5 && sinceBestMin !== null) {
    const back = best - nowPips;
    lines.push(`Best so far ${signed(best)} pips${sinceBestMin >= 1 ? ` (${minTxt(sinceBestMin)} ago${covered ? '' : ', in the candles kept'})` : ' — right now'}${back >= 0.5 ? `; ${pipTxt(back)} pips back from it` : ''}.`);
  }
  // the profit lock
  if (p.locked && stopPips !== null) lines.push(`Profit lock armed: the worst case now is ${signed(stopPips)} pips, and the stop follows the best price.`);
  else if (lockAtPips !== null) lines.push(`Profit lock arms at ${signed(lockAtPips)} pips (${fmt(p.lock!.at)})${lockAtPips > nowPips ? ` — ${pipTxt(lockAtPips - nowPips)} pips to go` : ''}.`);
  // pace
  if (etaMin !== null && etaMin <= 2 * holdMin) lines.push(`At the last hour's pace the target is about ${minTxt(etaMin)} away.`);
  if (thesis) lines.push(thesis);
  if (ahead) lines.push(`Ahead: ${ahead.name}, ${pipTxt(ahead.d)} pips away — the price often pauses there.`);
  if (behind) lines.push(`Behind: ${behind.name}, ${pipTxt(behind.d)} pips under the price${s === -1 ? ' (above, for a short)' : ''} — it can hold a dip.`);
  if (news) {
    const inMin = Math.round((news.t - now) / 60_000);
    lines.push(`${news.ccy} ${news.title} ${inMin > 0 ? `in ${minTxt(inMin)}` : inMin === 0 ? 'now' : `${minTxt(-inMin)} ago`} — prices can jump; a stop can fill worse than its level.`);
  }
  lines.push(`Open ${minTxt(ageMin)}${p.maxBars && TF_MIN[tf] ? `; closes on time after ${minTxt(holdMin)} if nothing else hits` : ''}.`);

  return {
    id: p.id,
    status,
    label: LABELS[status],
    goal,
    why: inp.strategy?.desc ?? null,
    pips: { now: r1(nowPips), target: targetPips === null ? null : r1(targetPips), stop: stopPips === null ? null : r1(stopPips), lockAt: lockAtPips === null ? null : r1(lockAtPips), best: r1(best), worst: r1(worst) },
    progressPct,
    move,
    sinceBestMin: sinceBestMin === null ? null : Math.round(sinceBestMin),
    etaMin,
    thesisOk,
    lines,
    ageMin: Math.round(ageMin),
  };
}
