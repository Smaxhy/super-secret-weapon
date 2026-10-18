/** Coins the bot wants but won't buy at the top: waiting for a dip into the buy zone + a bounce. One card each. */
import { Link } from 'react-router-dom';
import { STRATEGY_LABEL } from '../lib/format';
import { Badge, Empty, SectionHeader } from './ui';

export interface DipRow {
  mint: string;
  symbol: string;
  strategy: string;
  zoneLo: number;
  zoneHi: number;
  signalPrice: number;
  price: number | null;
  inZone: boolean;
  secondsLeft: number;
  why: string;
}

export function DipWatch({ rows }: { rows: DipRow[] | null }) {
  if (!rows?.length) return <Empty>Nothing waiting for a dip right now. Signals land here when every rule passed but the chart was stretched.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title="Waiting for a dip" description="Passed every rule but the chart was stretched: it waits for a pullback into the buy zone and a bounce instead of buying the top." />
      <ul className="stagger grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((w) => {
          const away = w.price ? (w.price / w.zoneHi - 1) * 100 : null;
          // Where the price sits: zone (lo–hi) on the left, signal price on the right.
          const lo = w.zoneLo * 0.95;
          const hi = Math.max(w.signalPrice, w.price ?? 0, w.zoneHi) * 1.02;
          const at = (x: number) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo || 1)) * 100))}%`;
          return (
            <li key={`${w.mint}-${w.strategy}`} className="card min-w-0 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={`/token/${w.mint}`} className="font-semibold text-ink hover:underline">{w.symbol}</Link>
                  <div className="mt-0.5"><Badge>{STRATEGY_LABEL[w.strategy] ?? w.strategy}</Badge></div>
                </div>
                <div className="tabular shrink-0 text-right text-sm text-ink-2">
                  {Math.floor(w.secondsLeft / 60)}:{String(w.secondsLeft % 60).padStart(2, '0')}
                  <div className="text-xs text-muted">left</div>
                </div>
              </div>
              <div className="relative mt-4 h-2 rounded-full bg-surface-3" role="img" aria-label={w.inZone ? 'In the buy zone' : away !== null ? `${away.toFixed(0)}% above the buy zone` : 'waiting'}>
                <div className="absolute inset-y-0 rounded-full bg-good/40" style={{ left: at(w.zoneLo), right: `calc(100% - ${at(w.zoneHi)})` }} />
                <span className="absolute -top-[3px] h-3.5 w-0.5 rounded bg-ink-2" style={{ left: at(w.signalPrice) }} title="signal price" />
                {w.price !== null && <span className={`absolute -top-[4px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-surface ${w.inZone ? 'bg-good' : 'bg-accent'}`} style={{ left: at(w.price) }} />}
              </div>
              <div className="mt-1.5 flex justify-between text-xs text-muted">
                <span>buy zone</span>
                <span>signal</span>
              </div>
              <p className={`mt-3 text-sm font-medium ${w.inZone ? 'text-up' : 'text-ink'}`}>{w.inZone ? 'In the buy zone, waiting for the bounce' : away !== null ? `${away.toFixed(0)}% above the buy zone` : 'Waiting for a price'}</p>
              <p className="mt-1 line-clamp-2 text-xs text-muted" title={w.why}>{w.why}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
