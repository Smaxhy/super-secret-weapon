/** v27.8 (owner: "if you're in a trade you're allowed to go higher than your TP, just set a tight trailing SL"). */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, RUN_PAST_TP, simulate, withRunPastTarget } from '../src/forex/engine';
import { buildCtx } from '../src/forex/ta';
import { INSTRUMENTS, type Bar, type Signal } from '../src/forex/types';

const H = 3_600_000;
const EUR = INSTRUMENTS[0]!;
const flat = (t: number, px: number): Bar => ({ t, o: px, h: px + 0.0001, l: px - 0.0001, c: px });
function market(after: Array<Partial<Bar>>): Bar[] {
  const t0 = Date.UTC(2025, 0, 6);
  const bars = Array.from({ length: 260 }, (_, i) => flat(t0 + i * H, 1.1));
  after.forEach((b, k) => {
    const px = b.c ?? 1.1;
    bars.push({ t: t0 + (260 + k) * H, o: b.o ?? px, h: b.h ?? px + 0.0001, l: b.l ?? px - 0.0001, c: px });
  });
  return bars;
}
const sig: Signal = { side: 1, stop: 1.099, target: 1.101 };
const run = (bars: Bar[], s: Signal, runPastTarget: boolean) => simulate(EUR, '1h', buildCtx(bars, 60, 'EURUSD'), 'x', bars.map((_, i) => (i === 250 ? s : null)), undefined, { ...DEFAULT_SIM, profitLock: false, runPastTarget });

describe('v27.8 run past the target with a tight trailing stop', () => {
  it('is on by default and only touches signals with a target and no trail of their own', () => {
    expect(RUN_PAST_TP.on).toBe(true);
    expect(DEFAULT_SIM.runPastTarget).toBe(true);
    expect(withRunPastTarget(sig)!.tpTrail).toBe(RUN_PAST_TP.atr);
    expect(withRunPastTarget({ ...sig, tpTrail: 2 })!.tpTrail).toBe(2);
    expect(withRunPastTarget({ ...sig, target: null })!.tpTrail).toBeUndefined();
  });

  it('a runner books more than the target; a pullback right after the target still keeps about the target', () => {
    const runner = market([{ o: 1.1, h: 1.1015, l: 1.0999, c: 1.1014 }, { c: 1.102 }, { c: 1.103 }, { c: 1.104 }, { o: 1.104, h: 1.104, l: 1.1, c: 1.1 }]);
    const atTarget = run(runner, sig, false)[0]!;
    const ran = run(runner, sig, true)[0]!;
    expect(atTarget.reason).toBe('target');
    expect(ran.reason).toBe('trail');
    expect(ran.r).toBeGreaterThan(atTarget.r + 1);
    // touches the target then falls straight back: the tight lock keeps most of it, never a loss
    const fade = market([{ o: 1.1, h: 1.1012, l: 1.0999, c: 1.1011 }, { o: 1.1011, h: 1.1011, l: 1.1, c: 1.1 }]);
    const f = run(fade, sig, true)[0]!;
    expect(f.r).toBeGreaterThan(0);
  });
});
