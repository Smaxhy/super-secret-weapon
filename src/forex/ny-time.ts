/**
 * v23: the New York clock as plain arithmetic (no Intl, no Redis, no logger) so pure code — the strategy context, the
 * ICT session rules, tests — can read it. calendar.ts re-exports these; nothing else changed.
 */
const dstSpan = new Map<number, [number, number]>();
/** US daylight-saving span of a year [start, end) in UTC ms (second Sunday of March 07:00 UTC → first Sunday of November 06:00 UTC). */
export function usDst(y: number): [number, number] {
  let s = dstSpan.get(y);
  if (!s) {
    const firstSun = (m: number) => 1 + ((7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7);
    s = [Date.UTC(y, 2, firstSun(2) + 7, 7), Date.UTC(y, 10, firstSun(10), 6)];
    dstSpan.set(y, s);
  }
  return s;
}
/** New York UTC offset at t (ms). Pure. */
export function nyOffsetMs(t: number): number {
  const [a, b] = usDst(new Date(t).getUTCFullYear());
  return t >= a && t < b ? -4 * 3_600_000 : -5 * 3_600_000;
}
/** Minutes since New York midnight at t (0…1439). Pure. */
export function nyMinOfDay(t: number): number {
  const d = new Date(t + nyOffsetMs(t));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
/** New York weekday at t (0 = Sunday). Pure. */
export function nyDow(t: number): number {
  return new Date(t + nyOffsetMs(t)).getUTCDay();
}
