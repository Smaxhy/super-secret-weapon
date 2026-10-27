/**
 * v27.66 (owner: "lock in and be more accurate — scan Kojiro's calls, see which ones hit and take those; a tight trailing
 * stop in moments of need"). His past posts (the copier uploads his channel history, `fx:discord:hist`, plus everything
 * it relayed live) are turned into calls — entry price + time + side, his later exit post, his SL, his daily plan and
 * levels in force at the time — and each call is replayed on the bot's own Nasdaq candles (15-minute, hourly where those
 * don't reach back) under the three ways the bot can hold it: `none` (his exit / the safety stop / 24 h), `copy` (+ the
 * copy trailing stop, live now) and `tight` (+ the tight profit lock). Every result is in R after the venue fee, the
 * stop hit first when a candle touches both, the entry candle skipped (nothing inside it is assumed).
 * The card it builds decides two things live (`kojiroGate`):
 *  - a call is skipped when it belongs to a kind of his calls that LOST (side / session / with or against his plan / at
 *    his level / with or without his SL: 8+ graded calls, average below 0 R, profit factor under 0.9);
 *  - the trailing stop his calls get = the way that made the most per call over 15+ calls (the current one is kept
 *    unless another beats it by 0.05 R).
 * Fewer calls than that = his calls are taken as before. Nothing here is lab-graded on unseen data — a track record of
 * one caller, read plainly.
 */
import type Redis from 'ioredis';
import { DISCORD_COPY, copyStop, parseBias, parseLevels, parseSignal } from './discord';
import { sessionOf, SESSIONS } from './montecarlo';
import { COPY_LOCK, PROFIT_LOCK, lockPlan, lockedStop } from './profit-lock';
import { loadBars, loadFastBars } from './data';
import { instrument, type Bar } from './types';
import { feeR } from './venue-fees';

export const KSTUDY = {
  histKey: 'fx:discord:hist',
  key: 'fx:discord:study',
  /** posts kept from the uploaded history */
  maxPosts: 5000,
  /** a call nobody closed is closed after this long */
  maxHoldMs: 24 * 3_600_000,
  /** a kind of his calls is skipped once this many graded calls lost */
  gateMinN: 8,
  gateMaxAvgR: 0,
  gatePf: 0.9,
  /** the trailing stop is switched only with this many graded calls, and only for a clear gain */
  pickMinN: 15,
  pickMargin: 0.05,
  /** his price must be inside the candle it was posted in (± this share of the stop distance) — else another contract */
  matchFrac: 0.35,
  /** a call within this % of one of his posted levels counts as "at his level" */
  levelPct: 0.1,
};

export type KPlan = 'none' | 'copy' | 'tight';
export const KPLANS: readonly KPlan[] = ['none', 'copy', 'tight'];
export const KPLAN_WORDS: Record<KPlan, string> = { none: 'his exit or the safety stop only', copy: 'the wide copy trailing stop', tight: 'the tight trailing stop' };

export interface HistPost {
  id: string;
  at: number;
  text: string;
}

export interface KCall {
  id: string;
  at: number;
  pair: string;
  side: 1 | -1;
  price: number;
  stopNamed: number | null;
  exitAt: number | null;
  exitPx: number | null;
  session: 0 | 1 | 2 | 3;
  /** his daily plan at the time: 1 with it, −1 against it, 0 none */
  bias: 1 | -1 | 0;
  atLevel: boolean;
}

export interface KSim {
  r: number;
  how: 'his' | 'stop' | 'trail' | 'time';
  mfeR: number;
  maeR: number;
}

export interface KStat {
  n: number;
  wins: number;
  avgR: number;
  pf: number | null;
  totalR: number;
}

export interface KSlice {
  key: string;
  label: string;
  stat: KStat;
  /** his other calls (not this kind) */
  rest: KStat;
  /** the gate skips calls of this kind */
  skip: boolean;
}

export interface KCard {
  at: number;
  posts: number;
  calls: number;
  graded: number;
  mismatched: number;
  noData: number;
  plans: Record<KPlan, KStat>;
  best: KPlan;
  slices: KSlice[];
  recent: { id: string; at: number; pair: string; side: 1 | -1; price: number; r: number; how: KSim['how'] }[];
}

/** His posts → calls (oldest first), each with his exit post and the plan / levels in force when he posted it. Pure. */
export function callsFrom(posts: readonly HistPost[]): KCall[] {
  const sorted = [...posts].sort((a, b) => a.at - b.at);
  const calls: KCall[] = [];
  const plan = new Map<string, { bias: 1 | -1 | 0; t: number }>();
  const levels = new Map<string, { levels: number[]; t: number }[]>();
  for (const p of sorted) {
    const sig = parseSignal(p.text);
    if (sig.kind === 'none') {
      const b = parseBias(p.text);
      if (b && b.bias !== null) plan.set(b.pair, { bias: b.bias, t: p.at });
      const lv = parseLevels(p.text);
      if (lv) levels.set(lv.pair, [...(levels.get(lv.pair) ?? []).filter((x) => p.at - x.t < 86_400_000), { levels: lv.levels, t: p.at }]);
      continue;
    }
    if (sig.kind === 'open' && sig.pair && sig.price !== null) {
      const pl = plan.get(sig.pair);
      const bias = pl && p.at - pl.t < 86_400_000 ? (pl.bias === 0 ? 0 : pl.bias === sig.side ? 1 : -1) : 0;
      const near = (levels.get(sig.pair) ?? []).filter((x) => p.at - x.t < 86_400_000).some((x) => x.levels.some((L) => Math.abs(L - sig.price!) <= (sig.price! * KSTUDY.levelPct) / 100));
      calls.push({ id: p.id, at: p.at, pair: sig.pair, side: sig.side, price: sig.price, stopNamed: sig.stop, exitAt: null, exitPx: null, session: sessionOf(p.at), bias, atLevel: near });
      continue;
    }
    if (sig.kind === 'close') {
      // his exit closes the oldest still-open call of that market and side ("SELL @" closes longs, "BUY / COVER @" shorts)
      for (const c of calls) {
        if (c.exitAt !== null || p.at - c.at > KSTUDY.maxHoldMs) continue;
        if (sig.pair && c.pair !== sig.pair) continue;
        if (sig.closes !== 0 && c.side !== sig.closes) continue;
        c.exitAt = p.at;
        c.exitPx = sig.price;
        if (sig.closes !== 0) break;
      }
    }
  }
  return calls;
}

const LOCK_CFG = { copy: COPY_LOCK, tight: PROFIT_LOCK } as const;

/** Replay one call on candles (oldest first) under one way of holding it. null = no candles there / not his market. Pure. */
export function simCall(c: KCall, bars: readonly Bar[], barMs: number, plan: KPlan): KSim | 'mismatch' | null {
  const i0 = bars.findIndex((b) => b.t <= c.at && c.at < b.t + barMs);
  if (i0 < 0 || i0 === bars.length - 1) return null;
  const stop0 = copyStop(c.side, c.price, c.stopNamed);
  const d = Math.abs(c.price - stop0);
  if (!(d > 0)) return null;
  const b0 = bars[i0]!;
  if (c.price < b0.l - KSTUDY.matchFrac * d || c.price > b0.h + KSTUDY.matchFrac * d) return 'mismatch';
  const inst = instrument(c.pair);
  const cost = inst ? feeR(inst, c.price, d) : 0;
  const R = (px: number) => (c.side * (px - c.price)) / d - cost;
  const lock = plan === 'none' ? null : lockPlan(c.side, c.price, stop0, null, 0, LOCK_CFG[plan]);
  let stop = stop0;
  let armed = false;
  let best = c.price;
  let mfe = 0;
  let mae = 0;
  // his exit inside the entry candle: out at his price
  if (c.exitAt !== null && c.exitPx !== null && c.exitAt < b0.t + barMs) return { r: R(c.exitPx), how: 'his', mfeR: 0, maeR: 0 };
  const end = c.at + KSTUDY.maxHoldMs;
  for (let j = i0 + 1; j < bars.length; j++) {
    const b = bars[j]!;
    const adverse = c.side === 1 ? b.l : b.h;
    const fav = c.side === 1 ? b.h : b.l;
    mae = Math.min(mae, (c.side * (adverse - c.price)) / d);
    // the stop first (a gap past it fills at the open)
    if (c.side * (adverse - stop) <= 0) {
      const px = c.side * (b.o - stop) <= 0 ? b.o : stop;
      return { r: R(px), how: armed ? 'trail' : 'stop', mfeR: mfe, maeR: mae };
    }
    if (c.exitAt !== null && c.exitPx !== null && c.exitAt < b.t + barMs) return { r: R(c.exitPx), how: 'his', mfeR: mfe, maeR: mae };
    mfe = Math.max(mfe, (c.side * (fav - c.price)) / d);
    if (lock) {
      if (!armed && c.side * (fav - lock.at) >= 0) armed = true;
      if (armed) {
        best = c.side === 1 ? Math.max(best, fav) : Math.min(best, fav);
        stop = lockedStop(c.side, lock, best, stop); // from the next candle on
      }
    }
    if (b.t + barMs >= end) return { r: R(b.c), how: 'time', mfeR: mfe, maeR: mae };
  }
  return null; // still running at the newest candle
}

export function statOf(rs: readonly number[]): KStat {
  const n = rs.length;
  const wins = rs.filter((r) => r > 0).length;
  const gw = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const gl = -rs.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  const totalR = rs.reduce((s, r) => s + r, 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n, wins, avgR: n ? r2(totalR / n) : 0, pf: gl > 0 ? r2(gw / gl) : gw > 0 ? null : 0, totalR: r2(totalR) };
}

/** The ways each call belongs to (the gate checks every one). Pure. */
export function sliceKeys(c: Pick<KCall, 'side' | 'session' | 'bias' | 'atLevel' | 'stopNamed'>): { key: string; label: string }[] {
  return [
    { key: `side:${c.side}`, label: c.side === 1 ? 'his long calls' : 'his short calls' },
    { key: `session:${c.session}`, label: `his calls in the ${SESSIONS[c.session]} session (New York time)` },
    { key: `plan:${c.bias}`, label: c.bias === 1 ? 'his calls WITH his daily plan' : c.bias === -1 ? 'his calls AGAINST his daily plan' : 'his calls on days without a plan' },
    { key: `level:${c.atLevel ? 1 : 0}`, label: c.atLevel ? 'his calls at one of his levels' : 'his calls away from his levels' },
    { key: `sl:${c.stopNamed !== null ? 1 : 0}`, label: c.stopNamed !== null ? 'his calls with an SL' : 'his calls without an SL' },
  ];
}

/** A kind of his calls is skipped only when it lost AND his other calls made money — that picks his winners; a losing
 * record across the board skips nothing (it is reported, the owner decides). */
const losing = (s: KStat, rest: KStat) => s.n >= KSTUDY.gateMinN && s.avgR < KSTUDY.gateMaxAvgR && (s.pf ?? 99) < KSTUDY.gatePf && rest.n >= KSTUDY.gateMinN && rest.avgR > 0;

/** The card from his posts and the candles of each market (`bars[pair]` = {bars, barMs}, finest first). Pure. */
export function buildCard(posts: readonly HistPost[], bars: Record<string, { bars: readonly Bar[]; barMs: number }[]>, prevBest: KPlan | null, now: number): KCard {
  const calls = callsFrom(posts);
  const res: { c: KCall; sims: Record<KPlan, KSim> }[] = [];
  let mismatched = 0;
  let noData = 0;
  for (const c of calls) {
    let got: Record<KPlan, KSim> | null = null;
    let mis = false;
    for (const src of bars[c.pair] ?? []) {
      const sims = KPLANS.map((p) => simCall(c, src.bars, src.barMs, p));
      if (sims.some((s) => s === 'mismatch')) {
        mis = true;
        continue;
      }
      if (sims.every((s) => s && s !== 'mismatch')) {
        got = { none: sims[0] as KSim, copy: sims[1] as KSim, tight: sims[2] as KSim };
        break;
      }
    }
    if (got) res.push({ c, sims: got });
    else if (mis) mismatched++;
    else noData++;
  }
  const plans = Object.fromEntries(KPLANS.map((p) => [p, statOf(res.map((x) => x.sims[p].r))])) as Record<KPlan, KStat>;
  let best: KPlan = prevBest ?? 'copy';
  const cand = KPLANS.filter((p) => plans[p].n >= KSTUDY.pickMinN).sort((a, b) => plans[b].avgR - plans[a].avgR)[0];
  if (cand && (plans[best].n < KSTUDY.pickMinN || plans[cand].avgR > plans[best].avgR + KSTUDY.pickMargin)) best = cand;
  const groups = new Map<string, { label: string; idx: Set<number> }>();
  res.forEach((x, i) => {
    for (const s of sliceKeys(x.c)) {
      const g = groups.get(s.key) ?? { label: s.label, idx: new Set<number>() };
      g.idx.add(i);
      groups.set(s.key, g);
    }
  });
  const slices = [...groups.entries()].map(([key, g]) => {
    const stat = statOf(res.filter((_, i) => g.idx.has(i)).map((x) => x.sims[best].r));
    const rest = statOf(res.filter((_, i) => !g.idx.has(i)).map((x) => x.sims[best].r));
    return { key, label: g.label, stat, rest, skip: losing(stat, rest) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const recent = res.slice(-30).reverse().map((x) => ({ id: x.c.id, at: x.c.at, pair: x.c.pair, side: x.c.side, price: x.c.price, r: Math.round(x.sims[best].r * 100) / 100, how: x.sims[best].how }));
  return { at: now, posts: posts.length, calls: calls.length, graded: res.length, mismatched, noData, plans, best, slices, recent };
}

/** Should the bot take this call, and with which trailing stop? No card / too few calls = take it as before. Pure. */
export function kojiroGate(card: KCard | null, c: Pick<KCall, 'side' | 'session' | 'bias' | 'atLevel' | 'stopNamed'>): { take: boolean; why: string | null; plan: KPlan } {
  const plan: KPlan = card && card.plans[card.best]?.n >= KSTUDY.pickMinN ? card.best : DISCORD_COPY.profitLock ? 'copy' : 'none';
  if (!card) return { take: true, why: null, plan };
  for (const k of sliceKeys(c)) {
    const s = card.slices.find((x) => x.key === k.key);
    if (s?.skip) return { take: false, why: `${k.label} lost: ${s.stat.n} calls, ${s.stat.avgR >= 0 ? '+' : ''}${s.stat.avgR}R a call, profit factor ${s.stat.pf ?? '—'}`, plan };
  }
  return { take: true, why: null, plan };
}

// ── storage ──

export async function saveHistory(redis: Redis, items: readonly HistPost[]): Promise<number> {
  const ok = items.filter((x) => /^[0-9]{5,25}$/.test(x.id) && x.text && Number.isFinite(x.at)).slice(0, 1000);
  if (!ok.length) return 0;
  await redis.hset(KSTUDY.histKey, ...ok.flatMap((x) => [x.id, JSON.stringify({ at: x.at, text: x.text.slice(0, 2000) })]));
  return ok.length;
}

export async function loadHistory(redis: Redis): Promise<HistPost[]> {
  const raw = (await redis.hgetall(KSTUDY.histKey).catch(() => ({}))) as Record<string, string>;
  const out: HistPost[] = [];
  for (const [id, v] of Object.entries(raw)) {
    try {
      const x = JSON.parse(v) as { at: number; text: string };
      out.push({ id, at: x.at, text: x.text });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, KSTUDY.maxPosts);
}

export async function loadCard(redis: Redis): Promise<KCard | null> {
  const raw = await redis.get(KSTUDY.key).catch(() => null);
  try {
    return raw ? (JSON.parse(raw) as KCard) : null;
  } catch {
    return null;
  }
}

/** Rebuild the card from everything stored (his history + live calls) on the bot's candles → Redis. */
export async function runKojiroStudy(redis: Redis, now = Date.now()): Promise<KCard> {
  const posts = await loadHistory(redis);
  const pairs = [...new Set(callsFrom(posts).map((c) => c.pair))];
  const bars: Record<string, { bars: readonly Bar[]; barMs: number }[]> = {};
  for (const id of pairs) bars[id] = [{ bars: await loadFastBars(redis, '15m', id), barMs: 15 * 60_000 }, { bars: await loadBars(redis, id), barMs: 3_600_000 }];
  const card = buildCard(posts, bars, (await loadCard(redis))?.best ?? null, now);
  await redis.set(KSTUDY.key, JSON.stringify(card));
  return card;
}
