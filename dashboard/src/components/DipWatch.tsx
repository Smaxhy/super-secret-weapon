/** Coins the bot wants but won't buy at the top: waiting for a dip into the buy zone + a bounce. */
import { Link } from 'react-router-dom';
import { Card, Empty } from './ui';

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
  const data = rows;
  if (!data?.length) return <Empty>Nothing waiting for a dip right now.</Empty>;
  return (
    <Card title="Waiting for a dip">
      <p className="mb-2 text-sm text-ink-2">Passed every rule but the chart was stretched — the bot waits for a pullback into the buy zone and a bounce instead of buying the top.</p>
      <ul className="divide-y divide-line text-sm">
        {data.map((w) => {
          const away = w.price ? (w.price / w.zoneHi - 1) * 100 : null;
          return (
            <li key={`${w.mint}-${w.strategy}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <Link to={`/token/${w.mint}`} className="font-semibold text-ink hover:underline">
                  {w.symbol}
                </Link>
                <div className="truncate text-xs text-muted">{w.why}</div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className={w.inZone ? 'text-up' : 'text-ink-2'}>{w.inZone ? 'in the buy zone — waiting for the bounce' : away !== null ? `${away.toFixed(0)}% above the buy zone` : 'waiting'}</div>
                <div className="text-xs text-muted">
                  {Math.floor(w.secondsLeft / 60)}:{String(w.secondsLeft % 60).padStart(2, '0')} left
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
