/**
 * v18: the quant desk's inputs from the lab's hourly bars (daily bars on the 22:00 UTC boundary, the fill bar two
 * hours into the next day, the policy-rate gap per day, USD conversion per day) and its report. Pure.
 */
import { carrySeries, type MacroData } from './macro';
import { CARVER, runDesk, type DailyMarket, type DeskInput, type DeskReport } from './forecast';
import { toDaily } from './mtf';
import { monteCarlo, type PortfolioResult } from './portfolio';
import { INSTRUMENTS, type Bar, type Instrument } from './types';

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const FX_DESK = 'fx:desk';
/** fills: this long after the day boundary (the 22:00 UTC rollover hour is avoided) */
export const DESK_FILL_DELAY_MS = 2 * HOUR;

export interface DeskOut extends DeskReport {
  /** Monte Carlo of the unseen weekly returns (13-week paths), like the honest test */
  mc: PortfolioResult['mc'];
}

/** The desk's calendar and per-market daily arrays from hourly bars. Pure. */
export function buildDeskInput(h1ById: ReadonlyMap<string, readonly Bar[]>, macro: MacroData | null, oosFrom: number, equity = 1000, insts: readonly Instrument[] = INSTRUMENTS): DeskInput | null {
  const daily = new Map<string, ReturnType<typeof toDaily>>();
  const days = new Set<number>();
  for (const inst of insts) {
    const h1 = h1ById.get(inst.id);
    if (!h1 || h1.length < 400) continue;
    const d = toDaily(h1);
    if (d.length < 60) continue;
    daily.set(inst.id, d);
    for (const b of d) days.add(b.t);
  }
  if (daily.size < 2) return null;
  const cal = [...days].sort((a, b) => a - b);
  const idx = new Map(cal.map((t, i) => [t, i]));
  const markets: DailyMarket[] = [];
  const closeBy = new Map<string, Float64Array>();
  for (const inst of insts) {
    const d = daily.get(inst.id);
    if (!d) continue;
    const n = cal.length;
    const close = new Float64Array(n).fill(NaN);
    const fill = new Float64Array(n).fill(NaN);
    const fillT = new Float64Array(n).fill(NaN);
    const fillPrevT = new Float64Array(n).fill(NaN);
    for (const b of d) close[idx.get(b.t)!] = b.c;
    // the fill bar: first hourly bar at or after the day's end + 2 h, within 3 days
    const h1 = h1ById.get(inst.id)!;
    let p = 0;
    for (let k = 0; k < n; k++) {
      const want = cal[k]! + DAY + DESK_FILL_DELAY_MS;
      while (p < h1.length && h1[p]!.t < want) p++;
      if (p < h1.length && h1[p]!.t < want + 3 * DAY) {
        fill[k] = h1[p]!.o;
        fillT[k] = h1[p]!.t;
        fillPrevT[k] = p > 0 ? h1[p - 1]!.t : NaN;
      }
    }
    const carry = macro ? carrySeries(macro, inst.id, d.map(({ t, o, h, l, c }) => ({ t, o, h, l, c })), 1440) : null;
    const carryAligned = carry ? new Float64Array(n).fill(NaN) : undefined;
    if (carry && carryAligned) d.forEach((b, j) => (carryAligned[idx.get(b.t)!] = carry[j]!));
    markets.push({ inst, close, fill, fillT, fillPrevT, ...(carryAligned ? { carry: carryAligned } : {}) });
    closeBy.set(inst.id, close);
  }
  // USD per currency per day (forward-filled) from the USD pairs among the markets
  const ff = (a: Float64Array) => {
    const out = new Float64Array(a.length);
    let last = NaN;
    for (let i = 0; i < a.length; i++) {
      if (Number.isFinite(a[i]!)) last = a[i]!;
      out[i] = last;
    }
    return out;
  };
  const usd = new Map<string, Float64Array>();
  for (const ccy of ['EUR', 'GBP', 'AUD', 'NZD', 'JPY', 'CAD', 'CHF']) {
    const direct = closeBy.get(`${ccy}USD`);
    const inverse = closeBy.get(`USD${ccy}`);
    if (direct) usd.set(ccy, ff(direct));
    else if (inverse) usd.set(ccy, ff(inverse).map((x) => (x > 0 ? 1 / x : NaN)));
  }
  return {
    cal,
    markets,
    oosFrom,
    equity,
    usdPer: (ccy, d) => {
      if (ccy === 'USD') return 1;
      const a = usd.get(ccy)?.[d];
      return a !== undefined && Number.isFinite(a) && a > 0 ? a : null;
    },
    volTarget: CARVER.volTarget,
  };
}

/** Build the inputs and run the desk (null when there is not enough history). Pure. */
export function deskFromBars(h1ById: ReadonlyMap<string, readonly Bar[]>, macro: MacroData | null, oosFrom: number, equity = 1000): DeskOut | null {
  const inp = buildDeskInput(h1ById, macro, oosFrom, equity);
  if (!inp) return null;
  const r = runDesk(inp);
  return { ...r, mc: monteCarlo(r.unseenWeekly, 2_000, 7) };
}
