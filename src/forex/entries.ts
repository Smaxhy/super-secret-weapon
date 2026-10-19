/**
 * v18 entry-timing lab (precision). The same signals, filters and exits with a different way IN:
 *  - market:   at the next bar's open plus half the spread (what the bot does today);
 *  - limit:    a limit order at the signal bar's close, good for one bar — filled only if the next bar trades back to
 *              it (a gap through it fills at the open); otherwise the trade is missed;
 *  - pullback: a limit order a quarter of an ATR back from the close, good for three bars;
 *  - confirm:  wait one bar; enter at the following open only if that bar closed the signal's way.
 * Fills follow the usual backtester rules (QuantConnect / backtrader): a limit fills when the bar's range reaches it,
 * at the limit price, or at the open when the open is already past it; an order that is not reached expires. A limit
 * that fills gets a better price (so a bigger reward for the same stop), but misses the trades that never came back —
 * the unseen 30% says which effect wins. Graded only (summarised per variant, never picked): the practice account has
 * no limit orders yet, so the bot keeps entering at market until that exists. Pure.
 */
import type { RStats } from './engine';

export type EntryKind = 'market' | 'limit' | 'pullback' | 'confirm';
export const ENTRIES: EntryKind[] = ['market', 'limit', 'pullback', 'confirm'];
export const ENTRY_LABEL: Record<EntryKind, string> = {
  market: 'at the next open (as now)',
  limit: 'limit at the signal close, one bar',
  pullback: 'limit ¼ ATR back, three bars',
  confirm: 'after a confirming bar',
};
export const ENTRY = {
  /** pullback limit: this many ATR back from the signal close */
  pullbackAtr: 0.25,
  /** bars a limit / pullback order stays good */
  limitBars: 1,
  pullbackBars: 3,
};

export interface EntryVariantRow {
  entry: EntryKind;
  inN: number;
  inAvgR: number;
  outN: number;
  outAvgR: number;
  outPf: number | null;
  allN: number;
  /** total R on the unseen 30% — a limit that fills fewer trades can win per trade and still earn less */
  outTotalR: number;
}

export interface EntrySummary {
  entry: EntryKind;
  label: string;
  /** strategies with enough trades to compare (30+ in the first 70% on both) */
  compared: number;
  /** average change in R a trade vs the market entry: first 70% / unseen 30% */
  inDeltaR: number;
  outDeltaR: number;
  /** % of compared strategies it improved per trade on the unseen 30% */
  outBetterPct: number;
  /** share of the market entry's unseen trades this variant still took (limits miss some) */
  filledPct: number;
  /** average change in TOTAL unseen R per strategy (per-trade gain × fills kept) */
  outTotalDeltaR: number;
}

/** Pure: how each entry variant did across the strategies (each under its own chosen filter + exit). */
export function summarizeEntries(rows: ReadonlyArray<{ id: string; entryVariants?: EntryVariantRow[] }>): EntrySummary[] {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return ENTRIES.filter((e) => e !== 'market').map((e) => {
    let compared = 0;
    let inD = 0;
    let outD = 0;
    let outN = 0;
    let better = 0;
    let fills = 0;
    let fillN = 0;
    let totalD = 0;
    for (const r of rows) {
      if (r.id === 'random' || !r.entryVariants) continue;
      const base = r.entryVariants.find((v) => v.entry === 'market');
      const v = r.entryVariants.find((x) => x.entry === e);
      if (!base || !v || base.inN < 30 || v.inN < 30) continue;
      compared++;
      inD += v.inAvgR - base.inAvgR;
      if (base.outN > 0) {
        fills += v.outN / base.outN;
        fillN++;
      }
      if (base.outN >= 15 && v.outN >= 15) {
        outN++;
        outD += v.outAvgR - base.outAvgR;
        totalD += v.outTotalR - base.outTotalR;
        if (v.outAvgR > base.outAvgR) better++;
      }
    }
    return { entry: e, label: ENTRY_LABEL[e], compared, inDeltaR: compared ? r2(inD / compared) : 0, outDeltaR: outN ? r2(outD / outN) : 0, outBetterPct: outN ? Math.round((better / outN) * 100) : 0, filledPct: fillN ? Math.round((fills / fillN) * 100) : 0, outTotalDeltaR: outN ? r2(totalD / outN) : 0 };
  });
}

/** The variant row from the lab's split stats. Pure. */
export function entryVariantRow(entry: EntryKind, x: { inSample: RStats; outSample: RStats; all: RStats }): EntryVariantRow {
  return { entry, inN: x.inSample.n, inAvgR: x.inSample.avgR, outN: x.outSample.n, outAvgR: x.outSample.avgR, outPf: x.outSample.pf, allN: x.all.n, outTotalR: x.outSample.totalR };
}
