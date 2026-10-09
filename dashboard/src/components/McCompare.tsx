/**
 * "Bought at MC → Market cap now" side by side, in SOL and USD, with the %
 * change. The arrow and +/− sign mean colour is never the only cue.
 */
import type { LivePosition } from '../hooks/useLivePositions';
import { mcSol, pct, usd } from '../lib/format';

export function McChange({ value, className = '' }: { value: number | null; className?: string }) {
  if (value === null || !Number.isFinite(value)) return <span className={`text-muted ${className}`}>—</span>;
  const tone = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-ink-2';
  return (
    <span className={`tabular font-semibold ${tone} ${className}`}>
      <span aria-hidden="true" className="mr-0.5 text-[0.75em]">{value > 0 ? '▲' : value < 0 ? '▼' : ''}</span>
      {pct(value, 1, true)}
    </span>
  );
}

export function McCompare({ p }: { p: LivePosition }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
      <div className="rounded-xl bg-surface-2 px-3 py-2.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Bought at MC</div>
        <McValue usdValue={p.mcEntryUsd} solValue={p.entryMarketCapSol} />
      </div>
      <div className="flex flex-col items-center justify-center px-1 text-center">
        <span aria-hidden="true" className="text-muted">→</span>
        <McChange value={p.mcChangePct} className="text-sm" />
      </div>
      <div className="rounded-xl bg-surface-2 px-3 py-2.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Market cap now</div>
        <McValue usdValue={p.mcNowUsd} solValue={p.mcNowSol} />
      </div>
    </div>
  );
}

/** Big USD number with SOL underneath; if the USD price is unknown, SOL becomes the big number. */
function McValue({ usdValue, solValue }: { usdValue: number | null; solValue: number | null }) {
  const hasUsd = usdValue !== null && Number.isFinite(usdValue);
  return (
    <>
      <div className="tabular mt-0.5 text-lg font-semibold text-ink sm:text-xl">{hasUsd ? usd(usdValue) : mcSol(solValue)}</div>
      <div className="tabular text-sm text-ink-2">{hasUsd ? mcSol(solValue) : 'USD price unavailable'}</div>
    </>
  );
}
