/**
 * v17.9 live prices to the dashboard: the Pyth ticks of the last second, folded per pair, published on the bus (the
 * WebSocket forwards it as { type: 'fx', data: { t, px: { EURUSD: [mid, bid, ask, priceT] } } }) — at most once a
 * second and only when something moved. Bid / ask use the same synthetic spread as the practice account, so the
 * dashboard's live P&L matches what a close would get.
 */
import { bus } from '../lib/bus';
import { pythLive, type LiveTick } from './pyth';
import { syntheticHalf } from './practice';
import { instrument } from './types';

const sig = (x: number) => Number(x.toPrecision(8));

/** One push payload from the pending ticks (pairs we don't trade are left out). Pure. */
export function pushPayload(ticks: Iterable<LiveTick>, now: number): Record<string, [number, number, number, number]> {
  const px: Record<string, [number, number, number, number]> = {};
  for (const t of ticks) {
    const inst = instrument(t.id);
    if (!inst || !(t.mid > 0)) continue;
    const half = syntheticHalf(inst, now);
    px[t.id] = [sig(t.mid), sig(t.mid - half), sig(t.mid + half), t.t];
  }
  return px;
}

/** Start pushing; returns the stop function. */
export function startLivePush(live: { onTicks(fn: (ticks: LiveTick[]) => void): () => void } = pythLive, everyMs = 1_000): () => void {
  const pending = new Map<string, LiveTick>();
  const off = live.onTicks((ts) => {
    for (const t of ts) pending.set(t.id, t);
  });
  const timer = setInterval(() => {
    if (!pending.size) return;
    const now = Date.now();
    const px = pushPayload(pending.values(), now);
    pending.clear();
    if (Object.keys(px).length) bus.publish({ type: 'fx', data: { t: now, px } });
  }, everyMs);
  timer.unref?.();
  return () => {
    off();
    clearInterval(timer);
  };
}
