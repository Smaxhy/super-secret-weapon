/**
 * v16 real spreads by hour. Dukascopy's bid / ask candles show how the spread of each market changes over the day
 * (wide at the 21–22 UTC rollover and in the quiet Asian hours, tight in London / New York). Their ECN spreads are
 * tighter than a retail account, so only the SHAPE is used: the cost of a bar = the typical retail spread × how much
 * wider than its median hour that hour is (never cheaper than the typical retail spread). Without a profile the old
 * rule applies (rollover ×3). Either way the first bar after the weekend costs ×4.
 */
import { isCrypto } from './types';
const HOUR = 3_600_000;

/** measured spread in pips per UTC hour (0–23), per market */
const profiles = new Map<string, number[]>();

/** Install / clear one market's hourly spread profile (from Dukascopy). */
export function setSpreadProfile(id: string, perHour: readonly number[] | null): void {
  if (!perHour || perHour.length !== 24 || perHour.some((x) => !Number.isFinite(x) || x <= 0)) profiles.delete(id);
  else profiles.set(id, [...perHour]);
}
export const clearSpreadProfiles = () => profiles.clear();
export const hasSpreadProfile = (id: string) => profiles.has(id);

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** How many typical retail spreads a bar opening at `t` costs (1 … 6). Pure apart from the installed profiles. */
export function spreadMultAt(id: string, t: number, prevT: number | null): number {
  if (isCrypto(id)) return 1; // v22: 24/7, no rollover hour, no weekend gap
  if (prevT !== null && t - prevT > 30 * HOUR) return 4;
  const h = new Date(t).getUTCHours();
  const p = profiles.get(id);
  if (!p) return h === 21 || h === 22 ? 3 : 1;
  const mid = median(p);
  return Math.min(6, Math.max(1, p[h]! / mid));
}

/** Median spread in pips per UTC hour from bar-close spreads [t, pips]. Hours with < 5 samples borrow the overall median. Pure. */
export function profileFrom(samples: ReadonlyArray<readonly [number, number]>): number[] | null {
  const byH: number[][] = Array.from({ length: 24 }, () => []);
  const all: number[] = [];
  for (const [t, s] of samples) {
    if (!(s > 0) || !Number.isFinite(s)) continue;
    byH[new Date(t).getUTCHours()]!.push(s);
    all.push(s);
  }
  if (all.length < 100) return null;
  const overall = median(all);
  return byH.map((xs) => (xs.length >= 5 ? Math.round(median(xs) * 1000) / 1000 : overall));
}
