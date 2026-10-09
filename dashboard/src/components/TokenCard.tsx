/** One row in the live feed. The whole row links to the token's breakdown. */
import { Link } from 'react-router-dom';
import { ago, num, pct, sol } from '../lib/format';
import type { Detection } from '../lib/types';
import { ScoreGauge } from './ScoreGauge';
import { StatusBadge } from './StatusBadge';

const EDGE: Record<Detection['feedStatus'], string> = {
  bought: 'border-l-good',
  flagged: 'border-l-critical',
  interesting: 'border-l-warning',
  skipped: 'border-l-line',
  pending: 'border-l-line',
};

export function TokenCard({ d }: { d: Detection }) {
  const metrics = [
    ['MC', d.live ? sol(d.live.marketCapSol, 1) : null],
    ['Holders', d.live ? num(d.live.holders) : null],
    ['Curve', d.live ? pct(d.live.curvePct) : null],
    ['Safety', d.safetyHardFail ? 'FAIL' : d.safetyScore !== null ? `${d.safetyScore}/100` : 'checking…'],
  ].filter(([, v]) => v !== null) as Array<[string, string]>;

  return (
    <Link to={`/token/${d.mint}`} className={`flex items-center gap-4 rounded-xl border border-l-4 border-line bg-surface p-3 hover:bg-surface-2 ${EDGE[d.feedStatus]}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold text-ink">{d.symbol || '?'}</span>
          <StatusBadge status={d.feedStatus} />
          <span className="text-sm text-muted">{ago(d.createdAt)}</span>
        </div>
        <div className="mt-1 truncate text-sm text-ink-2">{d.name}</div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm tabular">
          {metrics.map(([k, v]) => (
            <span key={k}>
              <span className="text-muted">{k} </span>
              <span className={k === 'Safety' && d.safetyHardFail ? 'font-semibold text-down' : 'text-ink'}>{v}</span>
            </span>
          ))}
        </div>
      </div>
      <ScoreGauge score={d.combinedScore} />
    </Link>
  );
}
