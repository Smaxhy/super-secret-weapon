/**
 * v18 overnight financing (swap / carry). A currency position earns the interest of the currency bought and pays the
 * interest of the one sold — the whole "carry" return is this term, and a backtest without it only measures the spot
 * leg (Lustig–Roussanov–Verdelhan 2011; every carry study). Retail brokers book it once a day at 17:00 New York
 * (Wednesday ×3 for the weekend) at the interbank differential minus their own markup on either side. The engine
 * accrues the same amount continuously per bar held (the bot is flat over weekends, so the ×3 only matters live);
 * the practice account books it at each roll. Rates = the BIS policy rates the bot already pulls (macro.ts);
 * metals pay nothing (−USD rate). Pure.
 */
import { nyOffsetMs } from './calendar';

export const FINANCING = {
  /** charge / credit financing in every backtest and on the practice accounts */
  on: true,
  /** the broker's markup on the differential, %-points a year, paid whichever way the trade goes (brokers don't
   * publish it; 0.5–1 is the usual retail spread on swaps). Env FX_SWAP_MARKUP_PCT on the VPS overrides it. */
  markupPct: (() => {
    const v = Number(process.env['FX_SWAP_MARKUP_PCT']);
    return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 0.75;
  })(),
  /** minutes in a year (365.25 days) */
  minutesPerYear: 525_960,
  /** New York hour of the daily roll */
  rollHourNy: 17,
};

/** Annual financing rate of a position, %: the carry its way minus the markup. NaN carry → NaN. Pure. */
export function finRatePct(side: 1 | -1, carryPct: number, markupPct = FINANCING.markupPct): number {
  return Number.isFinite(carryPct) ? side * carryPct - markupPct : NaN;
}

/** Financing for one bar held, in price units per unit of position (+ = earned). NaN carry → 0. Pure. */
export function finPerBar(side: 1 | -1, carryPct: number, close: number, barMin: number, markupPct = FINANCING.markupPct): number {
  const r = finRatePct(side, carryPct, markupPct);
  return Number.isFinite(r) ? ((r / 100) * barMin * close) / FINANCING.minutesPerYear : 0;
}

/** Financing for `days` daily rolls, in price units per unit of position (+ = earned). NaN carry → 0. Pure. */
export function swapGain(side: 1 | -1, carryPct: number, px: number, days: number, markupPct = FINANCING.markupPct): number {
  const r = finRatePct(side, carryPct, markupPct);
  return Number.isFinite(r) ? ((r / 100) * days * px) / 365 : 0;
}

/** The daily rolls (17:00 New York) in (from, to], each with the days it books (Wednesday's roll books 3). Pure. */
export function rollsBetween(from: number, to: number): Array<{ t: number; days: number }> {
  const out: Array<{ t: number; days: number }> = [];
  if (!(to > from)) return out;
  // walk New York calendar days from the day of `from`
  const ny = new Date(from + nyOffsetMs(from));
  const y = ny.getUTCFullYear();
  const m = ny.getUTCMonth();
  const d = ny.getUTCDate();
  for (let k = 0; k < 400; k++) {
    const wall = Date.UTC(y, m, d + k, FINANCING.rollHourNy); // 17:00 as if New York were UTC
    const t = wall - nyOffsetMs(wall + 4.5 * 3_600_000); // back to UTC with the offset in force at that moment
    if (t > to) break;
    if (t > from) out.push({ t, days: new Date(wall).getUTCDay() === 3 ? 3 : 1 });
  }
  return out;
}
