/** v28.13: the lab's profit lock must not invent an edge. On a driftless random walk (no edge possible) random entries
 * with the tight lock tested at +0.11R a trade because the engine assumed the rest of the candle after its best was only
 * its close; the bot's real rule (the stop moves when the candle closes) made about −0.03R. Now the engine applies the
 * moved stop from the next candle, like the bot, and both land near zero. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, simulate } from '../src/forex/engine';
import { buildCtx } from '../src/forex/ta';
import { instrument } from '../src/forex/types';
import { VENUE_FEES } from '../src/forex/venue-fees';
import { PROFIT_LOCK, lockPlan, lockedStop } from '../src/forex/profit-lock';
import { rng } from '../src/forex/stats';

describe('profit lock: lab vs the bot on the same minutes', () => {
  it('random entries on a driftless walk: the lab ≈ the bot\'s candle-close rule ≈ no edge', () => {
    const fees = VENUE_FEES.on;
    VENUE_FEES.on = false;
    Object.assign(PROFIT_LOCK, { on: true, atFrac: 0.15, gapFrac: 0.15, keepFrac: 0.05 });
    const r = rng(5);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
    const M = 60 * 24 * 300;
    const px: number[] = [];
    let p = 80_000;
    for (let i = 0; i < M; i++) {
      p *= Math.exp(0.0006 * gauss());
      px.push(p);
    }
    const t0 = Date.UTC(2025, 0, 6);
    const bars = [];
    for (let h = 0; h < M / 60; h++) {
      const s = px.slice(h * 60, h * 60 + 60);
      bars.push({ t: t0 + h * 3_600_000, o: s[0]!, h: Math.max(...s), l: Math.min(...s), c: s[59]! });
    }
    const ctx = buildCtx(bars, 60, 'BTCUSD');
    const sigs = bars.map((b, i) => {
      if (i < 300 || i % 7 !== 0) return null;
      const side = (r() < 0.5 ? 1 : -1) as 1 | -1;
      const a = ctx.atr14[i]!;
      return { side, stop: b.c - side * a, target: b.c + side * 2 * a };
    });
    const ts = simulate(instrument('BTCUSD')!, '1h', ctx, 'x', sigs as never, undefined, { ...DEFAULT_SIM, weekendPause: false, sessionSpreads: false, financing: false, venueFees: false, runPastTarget: false, lockKind: 'tight' });
    const done = ts.filter((t) => t.reason !== 'open');
    expect(done.length).toBeGreaterThan(500);
    const lab = done.reduce((s, t) => s + t.r, 0) / done.length;
    // the bot's rule on the minutes: the stop checked every minute, moved only when an hourly candle closes
    let sum = 0;
    let n = 0;
    for (const t of done) {
      const i0 = Math.round((t.entryT - t0) / 60_000);
      const risk = Math.abs(t.entry - t.stop0);
      const plan = lockPlan(t.side, t.entry, t.stop0, t.target0 ?? null, 0, PROFIT_LOCK)!;
      let stop = t.stop0;
      let best = t.entry;
      let locked = false;
      for (let m = i0; m < M; m++) {
        const x = px[m]!;
        if (t.side * (x - stop) <= 0 || (t.target0 != null && t.side * (x - t.target0) >= 0)) {
          sum += (t.side * (x - t.entry)) / risk;
          n++;
          break;
        }
        if (t.side * (x - plan.at) >= 0) locked = true;
        if (t.side * (x - best) > 0) best = x;
        if (locked && (m + 1) % 60 === 0) stop = lockedStop(t.side, plan, best, stop);
      }
    }
    const bot = sum / n;
    VENUE_FEES.on = fees;
    expect(Math.abs(lab)).toBeLessThan(0.05);
    expect(Math.abs(lab - bot)).toBeLessThan(0.05);
  }, 60_000);
});
