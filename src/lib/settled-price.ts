/**
 * The highest price we could really have SOLD at since `from`: a level only counts once
 * the price stayed at or above it for `holdMs`. Uses each trade's pool price after the
 * trade (`pp`, the price the next seller gets) or, without it, its execution price.
 *
 * Why: a sandwiched / high-slippage buy prints 20%+ above the market for a few
 * milliseconds (front-run buy → victim buy → back-run sell, all in one slot). Counting
 * that print as the peak armed the trailing stop / break-even floor and sold real
 * positions at a loss one second after entry. Nobody can sell into a 5 ms spike with
 * a 0.2–0.5 s fill. A real run holds its levels for at least a few slots. Pure.
 *
 * Trades are oldest → newest; `maxPx` drops impossible prints (bad decodes). null = no data.
 */
export function settledHigh(
  trades: ReadonlyArray<{ t: number; px: number; pp?: number; sol: number }>,
  from: number,
  now: number,
  holdMs: number,
  maxPx = Infinity,
): number | null {
  const priceOf = (x: { px: number; pp?: number; sol: number }) => (x.pp && x.pp > 0 ? x.pp : x.sol >= 0.02 ? x.px : 0);
  const pts = trades.filter((x) => x.t <= now && priceOf(x) > 0 && priceOf(x) <= maxPx);
  // Price as a step function: each trade's level holds until the next trade (the last one until now).
  const segs: Array<{ a: number; p: number }> = [];
  let k = -1;
  for (let j = 0; j < pts.length && pts[j]!.t <= from; j++) k = j;
  if (k >= 0) segs.push({ a: from, p: priceOf(pts[k]!) });
  for (let j = k + 1; j < pts.length; j++) segs.push({ a: pts[j]!.t, p: priceOf(pts[j]!) });
  let best = 0;
  // A window [start, start + holdMs] is best checked from a segment start (the min only falls later on).
  for (let i = 0; i < segs.length; i++) {
    const end = segs[i]!.a + Math.max(0, holdMs);
    if (end > now) break;
    let m = segs[i]!.p;
    for (let j = i + 1; j < segs.length && segs[j]!.a < end; j++) m = Math.min(m, segs[j]!.p);
    best = Math.max(best, m);
  }
  return best > 0 ? best : null;
}
