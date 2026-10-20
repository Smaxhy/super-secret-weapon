/**
 * Forex backtest engine (v12). Signal at a bar's close → filled at the next bar's open + half the spread.
 * Exits are checked on every bar's high / low (stop first when both are touched — the pessimistic choice),
 * gaps fill at the open, stops slip an extra quarter spread. Results are in R so any account size or leverage
 * can be applied afterwards (`equityCurve`).
 */
import { VENUE_FEES, feeR } from './venue-fees';
import { spreadMultAt } from './spreads';
import { ENTRY, type EntryKind } from './entries';
import { FINANCING, finPerBar } from './financing';
import { lockedStop, lockPlan, PROFIT_LOCK, type LockPlan } from './profit-lock';
import type { Ctx } from './ta';
import type { Strategy } from './strategies';
import type { Instrument, Signal, Timeframe, Trade } from './types';
import { runsOn } from './strategies';

export const WARMUP = 210;

/** Every bar's signal (null = none), computed once and reused by every filter variant. Strategies are pure. */
export function signalsFor(c: Ctx, s: Strategy): Array<Signal | null> {
  const n = c.bars.length;
  const out: Array<Signal | null> = new Array(n).fill(null);
  if (c.pair && !runsOn(s, c.barMin === 240 ? '4h' : c.barMin === 15 ? '15m' : c.barMin === 1 ? '1m' : '1h', c.pair)) return out; // v22: forex-only rules give no signal on a coin
  // v15: the last closed bar too — its signal is a trade the live bot takes right now (see `simulate`)
  for (let i = WARMUP; i < n; i++) out[i] = s.signal(c, i);
  return out;
}

/** ATR at bar i ÷ the median ATR of the 100 bars before it (how wild the market is right now vs normal). */
export function volRatioAt(c: Ctx, i: number): number | undefined {
  if (!c.vrCache || c.vrCache.length !== c.bars.length) c.vrCache = new Float64Array(c.bars.length).fill(-1);
  const hit = c.vrCache[i]!;
  if (hit !== -1) return Number.isNaN(hit) ? undefined : hit;
  let out: number | undefined;
  const a = c.atr14[i]!;
  if (Number.isFinite(a)) {
    const xs: number[] = [];
    for (let j = Math.max(0, i - 100); j < i; j++) if (Number.isFinite(c.atr14[j]!)) xs.push(c.atr14[j]!);
    if (xs.length >= 30) {
      const f = Float64Array.from(xs).sort();
      const med = f[Math.floor(f.length / 2)]!;
      out = med > 0 ? Math.round((a / med) * 100) / 100 : undefined;
    }
  }
  c.vrCache[i] = out === undefined ? NaN : out;
  return out;
}

/** `allow(i, side)` = false vetoes the entry signalled at bar i (filters); exits are never touched. */
export type Allow = (i: number, side: 1 | -1) => boolean;

export function runSeries(inst: Instrument, tf: Timeframe, c: Ctx, s: Strategy, allow?: Allow, opts?: SimOpts): Trade[] {
  return simulate(inst, tf, c, s.id, signalsFor(c, s), allow, opts);
}

const HOUR = 3_600_000;

/** v14: real spreads widen at the daily rollover (the 21:00 and 22:00 UTC bars) and right after the weekend open. */
export function spreadMult(t: number, prevT: number | null): number {
  if (prevT !== null && t - prevT > 30 * HOUR) return 4;
  const h = new Date(t).getUTCHours();
  return h === 21 || h === 22 ? 3 : 1;
}

export interface SimOpts {
  /** close before a weekend gap and re-enter at the first bar after it, unless the gap went through the stop or target
   * (exactly what the live bot does: it never holds over the weekend) */
  weekendPause?: boolean;
  /** charge the wider rollover / weekly-open spreads */
  sessionSpreads?: boolean;
  /** v15: a signal on the LAST closed bar becomes an open trade filled at that close (the next bar's open is not
   * known yet). Without it the live bot only saw a trade one bar after its signal and entered a whole bar late. */
  liveEdge?: boolean;
  /** v17.11: the owner's profit lock (profit-lock.ts) on every trade — the bot does it live */
  profitLock?: boolean;
  /** v18 entry-timing lab (entries.ts): how a signal gets in. 'market' = the next open (the bot); the others are
   * limit / confirmation variants graded by the lab (a signal on the last bar never becomes an open trade with them) */
  entry?: EntryKind;
  /** v18: accrue overnight financing (the carry its way minus the broker markup) on every bar held (financing.ts) —
   * the practice account books the same at each daily roll. Needs `ctx.ext.carry` (policy rates); unknown = 0. */
  financing?: boolean;
  /** v26: charge the trading venue's open + close fee (gTrade, venue-fees.ts) on every trade */
  venueFees?: boolean;
}
export const DEFAULT_SIM: Required<SimOpts> = { weekendPause: true, sessionSpreads: true, liveEdge: true, profitLock: PROFIT_LOCK.on, entry: 'market', financing: FINANCING.on, venueFees: VENUE_FEES.on };

export function simulate(inst: Instrument, tf: Timeframe, c: Ctx, strategyId: string, sigs: ReadonlyArray<Signal | null>, allow?: Allow, opts: SimOpts = DEFAULT_SIM): Trade[] {
  const o = { ...DEFAULT_SIM, ...opts };
  const bars = c.bars;
  const n = bars.length;
  const base = inst.spreadPips * inst.pip;
  // v16: the hour-by-hour shape of the real spread (Dukascopy) when measured, else the rollover rule
  const spr = (i: number) => (o.sessionSpreads ? base * spreadMultAt(inst.id, bars[i]!.t, i > 0 ? bars[i - 1]!.t : null) : base);
  const out: Trade[] = [];
  type Pos = {
    side: 1 | -1;
    entryIdx: number;
    entry: number;
    stop: number;
    stop0: number;
    target: number | null;
    trailAtr: number | null;
    maxBars: number | null;
    exitWhen: string | null;
    best: number;
    volRatio: number | undefined;
    /** |entry − first stop| = 1R */
    risk: number;
    /** fill of the current leg (changes after a weekend re-entry) */
    legEntry: number;
    /** share of the position still open */
    frac: number;
    /** R already banked by scale-outs and weekend legs */
    realized: number;
    beAt: number | null;
    scaleAt: number | null;
    scaleFrac: number;
    scaled: boolean;
    be: boolean;
    trailed: boolean;
    /** v15 trailing take-profit: ATR multiple to trail after the target, the lock distance (price, set at entry), the
     * share taken off at the target, and whether the target was reached */
    tpTrail: number | null;
    tpDist: number | null;
    tpFrac: number;
    tpHit: boolean;
    /** the target at entry (the live one becomes null once a trailing take-profit takes over) */
    target0: number | null;
    /** v15.1 trailing stop-loss: the stop follows the best close this far behind (price; null = off) */
    trailPx: number | null;
    /** v15.3: the trade's identity time = its signal bar's close (stays the same when the next bar is missing) */
    keyT: number;
    /** v17.11 the owner's profit lock (null = none) and its state */
    lock: LockPlan | null;
    locked: boolean;
    lockBest: number;
    /** v18: R earned / paid as financing so far (inside `realized`) */
    fin: number;
  };
  let pos: Pos | null = null;
  const carry = o.financing ? c.ext?.carry : undefined;
  /** v18: an order waiting to fill (limit / pullback / confirmation variants) */
  type Pend = { sig: Signal; sigIdx: number; kind: EntryKind; limit: number | null; until: number };
  let pend: Pend | null = null;
  /** open a position from signal `sig` (fired at bar sigIdx) filled at bar entryIdx at price `entry` (spread included) */
  const openAt = (sig: Signal, sigIdx: number, entryIdx: number, entry: number): Pos | null => {
    const ok = sig.side === 1 ? sig.stop < entry && (sig.target === null || sig.target > entry) : sig.stop > entry && (sig.target === null || sig.target < entry);
    // the stop must be worth more than the spread, else the trade is all cost
    if (!ok || Math.abs(entry - sig.stop) <= 2 * spr(entryIdx)) return null;
    const risk = Math.abs(entry - sig.stop);
    return {
      side: sig.side,
      entryIdx,
      keyT: bars[sigIdx]!.t + c.barMin * 60_000,
      entry,
      stop: sig.stop,
      stop0: sig.stop,
      target: sig.target,
      trailAtr: sig.trailAtr ?? null,
      maxBars: sig.maxBars ?? null,
      exitWhen: sig.exitWhen ?? null,
      best: entry,
      volRatio: volRatioAt(c, sigIdx),
      risk,
      legEntry: entry,
      frac: 1,
      realized: 0,
      beAt: sig.beAtR ? entry + sig.side * sig.beAtR * risk : null,
      scaleAt: sig.scaleAtR ? entry + sig.side * sig.scaleAtR * risk : null,
      scaleFrac: Math.min(0.9, Math.max(0.1, sig.scaleFrac ?? 0.5)),
      scaled: false,
      be: false,
      trailed: false,
      tpTrail: sig.tpTrail && sig.target !== null ? sig.tpTrail : null,
      tpDist: sig.tpTrail && sig.target !== null ? sig.tpTrail * (Number.isFinite(c.atr14[sigIdx]!) && c.atr14[sigIdx]! > 0 ? c.atr14[sigIdx]! : risk) : null,
      tpFrac: Math.min(0.9, Math.max(0, sig.tpFrac ?? 0)),
      tpHit: false,
      target0: sig.target,
      trailPx: sig.trailR && sig.trailR > 0 ? sig.trailR * risk : null,
      lock: o.profitLock ? lockPlan(sig.side, entry, sig.stop, sig.target, spr(entryIdx)) : null,
      locked: false,
      lockBest: entry,
      fin: 0,
    };
  };
  const finish = (i: number, fill: number, reason: Trade['reason']) => {
    const p = pos!;
    // v26: the venue's open + close fee on the whole position (venue-fees.ts), in R
    const fee = o.venueFees ? feeR(inst, p.entry, p.risk) : 0;
    const r = p.realized + (p.frac * p.side * (fill - p.legEntry)) / p.risk - fee;
    out.push({
      strategy: strategyId,
      tf,
      pair: inst.id,
      side: p.side,
      entryT: bars[p.entryIdx]!.t,
      keyT: p.keyT,
      exitT: bars[i]!.t,
      entry: p.entry,
      exit: fill,
      r,
      stopPct: (p.risk / p.entry) * 100,
      reason,
      bars: i - p.entryIdx + 1,
      stop: p.stop,
      stop0: p.stop0,
      target: p.target,
      ...(p.fin !== 0 ? { fin: p.fin } : {}),
      ...(p.volRatio !== undefined ? { volRatio: p.volRatio } : {}),
      ...(p.beAt !== null ? { beAt: p.beAt } : {}),
      ...(p.scaleAt !== null ? { scaleAt: p.scaleAt, scaleFrac: p.scaleFrac, scaled: p.scaled } : {}),
      ...(p.tpDist !== null ? { tpTrailPx: p.tpDist, tpFrac: p.tpFrac, tpHit: p.tpHit, ...(p.tpHit ? { target0: p.target0 } : {}) } : {}),
      // an open trade carries the exit rules still in force (the bot's plan shows them)
      ...(reason === 'open' ? { ...(p.trailAtr !== null ? { trailAtr: p.trailAtr } : {}), ...(p.trailPx !== null ? { trailPx: p.trailPx } : {}), ...(p.maxBars !== null ? { maxBars: p.maxBars } : {}), ...(p.exitWhen ? { exitWhen: p.exitWhen } : {}) } : {}),
    });
    pos = null;
  };
  /** exit side of the book; stops slip an extra quarter spread */
  const exitFill = (i: number, side: 1 | -1, px: number, slip: boolean) => px - (side * spr(i)) / 2 - (slip ? side * spr(i) * 0.25 : 0);
  const stopReason = (p: Pos): Trade['reason'] => (p.trailed ? 'trail' : p.be ? 'breakeven' : 'stop');
  for (let i = WARMUP; i < n; i++) {
    const b = bars[i]!;
    // v18: an order from an earlier signal waiting to fill — checked before this bar's exits, so a fill inside the
    // bar gets the bar's stop / target check like any entry bar
    if (pend && !pos && i > pend.sigIdx) {
      const pd: Pend = pend;
      const s: 1 | -1 = pd.sig.side;
      if (b.t - bars[i - 1]!.t > 30 * HOUR || i > pd.until) pend = null; // an order never survives the weekend / its life
      else if (pd.kind === 'confirm') {
        // the bar after the signal must close the signal's way; then a market entry at the next open
        pend = (s === 1 ? b.c > b.o : b.c < b.o) && i < n - 1 ? { sig: pd.sig, sigIdx: pd.sigIdx, kind: 'market', limit: null, until: i + 1 } : null;
      } else if (pd.kind === 'market') {
        pos = openAt(pd.sig, pd.sigIdx, i, b.o + (s * spr(i)) / 2);
        pend = null;
      } else {
        const L = pd.limit!;
        if (s === 1 ? b.l <= L : b.h >= L) {
          pos = openAt(pd.sig, pd.sigIdx, i, (s === 1 ? Math.min(b.o, L) : Math.max(b.o, L)) + (s * spr(i)) / 2);
          pend = null;
        }
      }
    }
    // weekend: bank the leg at Friday's close; skip the gap; carry on from the first bar after it
    if (pos && o.weekendPause && pos.entryIdx < i && b.t - bars[i - 1]!.t > 30 * HOUR) {
      const p: Pos = pos;
      const legOut = exitFill(i - 1, p.side, bars[i - 1]!.c, false);
      p.realized += (p.frac * p.side * (legOut - p.legEntry)) / p.risk;
      p.legEntry = legOut;
      const through = (p.side === 1 ? b.o <= p.stop : b.o >= p.stop) || (p.target !== null && (p.side === 1 ? b.o >= p.target : b.o <= p.target));
      if (through) {
        p.frac = 0; // flat over the weekend and the gap went past a level: the trade ended at Friday's close
        finish(i - 1, legOut, 'weekend');
      } else p.legEntry = b.o + (p.side * spr(i)) / 2;
    }
    if (pos && pos.entryIdx <= i) {
      const p: Pos = pos;
      // v18: financing for this bar held (the carry its way minus the markup), on the share still open
      if (carry && p.frac > 0) {
        const f = (p.frac * finPerBar(p.side, carry[i]!, b.c, c.barMin)) / p.risk;
        p.fin += f;
        p.realized += f;
      }
      const hitStop = p.side === 1 ? b.l <= p.stop : b.h >= p.stop;
      const hitTgt = p.target !== null && (p.side === 1 ? b.h >= p.target : b.l <= p.target);
      if (hitStop) finish(i, exitFill(i, p.side, p.side === 1 ? Math.min(b.o, p.stop) : Math.max(b.o, p.stop), true), stopReason(p));
      else if (hitTgt && p.tpDist !== null && !p.tpHit) {
        // v15 trailing take-profit: the target is not the end. Part off (if any), the stop locks behind the target
        // (never under break-even + costs), then it trails behind the best close; the strategy's own time / indicator
        // exits stop counting — only the trailing stop closes it from here.
        const at = p.side === 1 ? Math.max(b.o, p.target!) : Math.min(b.o, p.target!);
        if (p.tpFrac > 0) {
          const part = p.frac * p.tpFrac;
          p.realized += (part * p.side * (exitFill(i, p.side, at, false) - p.legEntry)) / p.risk;
          p.frac -= part;
        }
        p.tpHit = true;
        p.target = null;
        p.exitWhen = null;
        p.maxBars = null;
        p.trailAtr = p.tpTrail;
        p.best = p.side === 1 ? Math.max(p.best, at) : Math.min(p.best, at);
        const lock = at - p.side * p.tpDist;
        const be = p.entry + p.side * spr(i);
        const ns = p.side === 1 ? Math.max(lock, be) : Math.min(lock, be);
        if (p.side === 1 ? ns > p.stop : ns < p.stop) p.stop = ns;
        p.trailed = true;
        p.be = true;
        // rest of the candle: open → low → high → close on a green candle, open → high → low → close on a red one
        // (a long's target is touched at the high: a red candle still has its low to come, a green one only its close).
        // A gap through the target at the open: the whole candle is still to come.
        const gap = at === b.o;
        const back = p.side === 1 ? (gap || b.c < b.o ? b.l : b.c) <= p.stop : (gap || b.c > b.o ? b.h : b.c) >= p.stop;
        if (back) finish(i, exitFill(i, p.side, p.stop, true), 'trail');
      } else if (hitTgt) finish(i, exitFill(i, p.side, p.side === 1 ? Math.max(b.o, p.target!) : Math.min(b.o, p.target!), false), 'target');
      else {
        // take part off / move the stop to break-even (checked after the stop: the pessimistic order)
        let toBe = false;
        if (!p.scaled && p.scaleAt !== null && (p.side === 1 ? b.h >= p.scaleAt : b.l <= p.scaleAt)) {
          const fill = exitFill(i, p.side, p.side === 1 ? Math.max(b.o, p.scaleAt) : Math.min(b.o, p.scaleAt), false);
          // a share of what is still open (a trailing take-profit may already have taken part off)
          const part = p.frac * p.scaleFrac;
          p.realized += (part * p.side * (fill - p.legEntry)) / p.risk;
          p.frac -= part;
          p.scaled = true;
          toBe = true;
        }
        if (!p.be && p.beAt !== null && (p.side === 1 ? b.h >= p.beAt : b.l <= p.beAt)) toBe = true;
        if (toBe && !p.be) {
          const beStop = p.entry + p.side * spr(i);
          if (p.side === 1 ? beStop > p.stop : beStop < p.stop) p.stop = beStop;
          p.be = true;
          // the same candle may have come back to the new stop afterwards: assume it did (the order inside a candle is unknown)
          if (p.side === 1 ? b.l <= p.stop : b.h >= p.stop) finish(i, exitFill(i, p.side, p.stop, true), 'breakeven');
        }
        // v17.11 the owner's profit lock: ⅓ of the way to the target → the stop jumps past the entry, then trails ⅓ of
        // the target distance behind the best price (the bot does it on live prices; here on the candle's high / low).
        // After the candle's best price only the rest of the candle can hit it: a long's green candle (open → low →
        // high → close) only its close, a red one (open → high → low → close) its low.
        if (pos && p.lock) {
          const ext = p.side === 1 ? b.h : b.l;
          if (!p.locked && (p.side === 1 ? ext >= p.lock.at : ext <= p.lock.at)) {
            p.locked = true;
            p.be = true;
          }
          if (p.locked) {
            p.lockBest = p.side === 1 ? Math.max(p.lockBest, ext) : Math.min(p.lockBest, ext);
            const ns = lockedStop(p.side, p.lock, p.lockBest, p.stop);
            if (ns !== p.stop) {
              p.stop = ns;
              if (p.side * (ns - p.lock.to) > 0) p.trailed = true;
            }
            const after = p.side === 1 ? (b.c >= b.o ? b.c : b.l) : b.c <= b.o ? b.c : b.h;
            if (p.side === 1 ? after <= p.stop : after >= p.stop) finish(i, exitFill(i, p.side, p.stop, true), stopReason(p));
          }
        }
        if (pos) {
          const held = i - p.entryIdx + 1;
          const ew = p.exitWhen;
          const exitNow =
            (ew === 'aboveSma5' && (p.side === 1 ? b.c > c.sma5[i]! : b.c < c.sma5[i]!)) ||
            (ew === 'midBand' && (p.side === 1 ? b.c >= c.bb.mid[i]! : b.c <= c.bb.mid[i]!)) ||
            (ew === 'ema20' && (p.side === 1 ? b.c >= c.ema20[i]! : b.c <= c.ema20[i]!));
          if (exitNow) finish(i, exitFill(i, p.side, b.c, false), 'exit');
          else if (p.maxBars !== null && held >= p.maxBars) finish(i, exitFill(i, p.side, b.c, false), 'time');
          else if (p.trailAtr !== null || p.trailPx !== null) {
            // trail behind the best close: ATR-based (strategy / runner / trailing take-profit) and / or the fixed
            // distance of a trailing stop-loss — the tighter one counts, and the stop only ever moves with the trade
            p.best = p.side === 1 ? Math.max(p.best, b.c) : Math.min(p.best, b.c);
            const cands: number[] = [];
            if (p.trailAtr !== null && Number.isFinite(c.atr14[i]!)) cands.push(p.best - p.side * p.trailAtr * c.atr14[i]!);
            if (p.trailPx !== null) cands.push(p.best - p.side * p.trailPx);
            for (const t of cands) {
              if (p.side === 1 ? t > p.stop : t < p.stop) {
                p.stop = t;
                p.trailed = true;
              }
            }
          }
        }
      }
    }
    if (!pos && i < n - 1) {
      const sig = sigs[i];
      if (sig && (!allow || allow(i, sig.side))) {
        if (o.entry === 'market') pos = openAt(sig, i, i + 1, bars[i + 1]!.o + (sig.side * spr(i + 1)) / 2);
        else if (o.entry === 'confirm') pend = { sig, sigIdx: i, kind: 'confirm', limit: null, until: i + 1 };
        else {
          // a limit at the close (one bar) or a quarter ATR back from it (three bars); it must sit on the right side of the stop
          const a = c.atr14[i]!;
          const L = o.entry === 'limit' ? b.c : b.c - sig.side * ENTRY.pullbackAtr * (Number.isFinite(a) && a > 0 ? a : 0);
          pend = (sig.side === 1 ? L > sig.stop : L < sig.stop) ? { sig, sigIdx: i, kind: o.entry, limit: L, until: i + (o.entry === 'limit' ? ENTRY.limitBars : ENTRY.pullbackBars) } : null;
        }
      }
    }
  }
  if (pos) finish(n - 1, bars[n - 1]!.c, 'open');
  else if (o.liveEdge && o.entry === 'market' && n > WARMUP) {
    // the bar that just closed fired: an open trade from the next bar's open (≈ this close), so the bot can take it now
    const i = n - 1;
    const sig = sigs[i];
    if (sig && (!allow || allow(i, sig.side))) {
      const entry = bars[i]!.c + (sig.side * spr(i)) / 2;
      const valid = sig.side === 1 ? sig.stop < entry && (sig.target === null || sig.target > entry) : sig.stop > entry && (sig.target === null || sig.target < entry);
      const risk = Math.abs(entry - sig.stop);
      if (valid && risk > 2 * spr(i)) {
        const t = bars[i]!.t + c.barMin * 60_000;
        const a = c.atr14[i]!;
        const tp = sig.tpTrail && sig.target !== null ? sig.tpTrail : null;
        out.push({
          strategy: strategyId,
          tf,
          pair: inst.id,
          side: sig.side,
          entryT: t,
          keyT: t,
          exitT: t,
          entry,
          exit: entry,
          r: 0,
          stopPct: (risk / entry) * 100,
          reason: 'open',
          bars: 0,
          stop: sig.stop,
          stop0: sig.stop,
          target: sig.target,
          ...(() => {
            const v = volRatioAt(c, i);
            return v !== undefined ? { volRatio: v } : {};
          })(),
          ...(sig.beAtR ? { beAt: entry + sig.side * sig.beAtR * risk } : {}),
          ...(sig.scaleAtR ? { scaleAt: entry + sig.side * sig.scaleAtR * risk, scaleFrac: Math.min(0.9, Math.max(0.1, sig.scaleFrac ?? 0.5)), scaled: false } : {}),
          ...(tp !== null ? { tpTrailPx: tp * (Number.isFinite(a) && a > 0 ? a : risk), tpFrac: Math.min(0.9, Math.max(0, sig.tpFrac ?? 0)), tpHit: false } : {}),
          ...(sig.trailAtr ? { trailAtr: sig.trailAtr } : {}),
          ...(sig.trailR && sig.trailR > 0 ? { trailPx: sig.trailR * risk } : {}),
          ...(sig.maxBars ? { maxBars: sig.maxBars } : {}),
          ...(sig.exitWhen ? { exitWhen: sig.exitWhen } : {}),
        });
      }
    }
  }
  return out;
}

export interface RStats {
  n: number;
  winPct: number;
  avgR: number;
  medianR: number;
  pf: number | null;
  totalR: number;
  /** worst peak-to-trough of cumulative R */
  maxDdR: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function rStats(ts: readonly Trade[]): RStats {
  const done = ts.filter((t) => t.reason !== 'open');
  const n = done.length;
  if (!n) return { n: 0, winPct: 0, avgR: 0, medianR: 0, pf: null, totalR: 0, maxDdR: 0 };
  const rs = done.map((t) => t.r).sort((a, b) => a - b);
  let gw = 0;
  let gl = 0;
  for (const r of rs) if (r > 0) gw += r; else gl -= r;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of [...done].sort((a, b) => a.exitT - b.exitT)) {
    cum += t.r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return { n, winPct: Math.round((rs.filter((r) => r > 0).length / n) * 100), avgR: r2(cum / n), medianR: r2(rs[Math.floor(n / 2)]!), pf: gl > 0 ? r2(gw / gl) : gw > 0 ? null : 0, totalR: r2(cum), maxDdR: r2(dd) };
}

export interface RiskResult {
  riskPct: number;
  /** account multiple at the end (1 = flat) */
  finalX: number;
  avgWeekPct: number;
  medianWeekPct: number;
  greenWeeksPct: number;
  /** share of weeks that made +10% or more */
  bigWeeksPct: number;
  bestWeekPct: number;
  worstWeekPct: number;
  maxDdPct: number;
  /** account fell under 10% of its peak → wiped */
  blown: boolean;
  medianLeverage: number;
  weeks: number;
}

const WEEK = 7 * 86_400_000;

/**
 * Compound the trades at `riskPct` of equity per trade (leverage capped at `maxLev`; a trade needing more is
 * sized down to the cap). Concurrent trades share the equity at their entry. Weekly results from Monday 00:00 UTC.
 */
export function equityCurve(ts: readonly Trade[], riskPct: number, maxLev: number): RiskResult {
  const done = ts.filter((t) => t.reason !== 'open');
  const empty: RiskResult = { riskPct, finalX: 1, avgWeekPct: 0, medianWeekPct: 0, greenWeeksPct: 0, bigWeeksPct: 0, bestWeekPct: 0, worstWeekPct: 0, maxDdPct: 0, blown: false, medianLeverage: 0, weeks: 0 };
  if (!done.length) return empty;
  type Ev = { t: number; kind: 0 | 1; tr: Trade; risk?: number };
  const ev: Ev[] = [];
  for (const tr of done) {
    ev.push({ t: tr.entryT, kind: 0, tr });
    ev.push({ t: tr.exitT, kind: 1, tr });
  }
  // exits before entries at the same time (frees the equity first)
  ev.sort((a, b) => a.t - b.t || b.kind - a.kind);
  const riskOf = new Map<Trade, number>();
  const levs: number[] = [];
  let eq = 1;
  let peak = 1;
  let dd = 0;
  let blown = false;
  const mon = (t: number) => {
    // weeks start Monday 00:00 UTC (epoch was a Thursday → +4 days)
    return Math.floor((t + 4 * 86_400_000) / WEEK);
  };
  const firstWeek = mon(ev[0]!.t);
  const weekEnd = new Map<number, number>();
  for (const e of ev) {
    if (blown) break;
    if (e.kind === 0) {
      let lev = riskPct / e.tr.stopPct;
      let risk = riskPct;
      if (lev > maxLev) {
        lev = maxLev;
        risk = maxLev * e.tr.stopPct;
      }
      levs.push(lev);
      riskOf.set(e.tr, (risk / 100) * eq);
    } else {
      const amt = riskOf.get(e.tr) ?? 0;
      eq = Math.max(0, eq + amt * e.tr.r);
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak > 0 ? 1 - eq / peak : 1);
      if (eq <= 0.1 * peak) blown = true;
      weekEnd.set(mon(e.t), eq);
    }
  }
  const lastWeek = mon(ev[ev.length - 1]!.t);
  const weekly: number[] = [];
  let prev = 1;
  for (let w = firstWeek; w <= lastWeek; w++) {
    const v = weekEnd.get(w) ?? prev;
    weekly.push(prev > 0 ? (v / prev - 1) * 100 : 0);
    prev = v;
    if (blown && v <= 0.1 * peak) break;
  }
  const sorted = [...weekly].sort((a, b) => a - b);
  levs.sort((a, b) => a - b);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    riskPct,
    finalX: r2(eq),
    avgWeekPct: r1(weekly.reduce((a, b) => a + b, 0) / Math.max(1, weekly.length)),
    medianWeekPct: r1(sorted[Math.floor(sorted.length / 2)] ?? 0),
    greenWeeksPct: Math.round((weekly.filter((x) => x > 0).length / Math.max(1, weekly.length)) * 100),
    bigWeeksPct: Math.round((weekly.filter((x) => x >= 10).length / Math.max(1, weekly.length)) * 100),
    bestWeekPct: r1(sorted[sorted.length - 1] ?? 0),
    worstWeekPct: r1(sorted[0] ?? 0),
    maxDdPct: Math.round(dd * 100),
    blown,
    medianLeverage: r1(levs[Math.floor(levs.length / 2)] ?? 0),
    weeks: weekly.length,
  };
}
