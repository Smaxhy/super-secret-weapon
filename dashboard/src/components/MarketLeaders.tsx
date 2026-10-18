/** "What's working now": top coins (ours + DexScreener) and the narratives they share. */
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { Card, Empty } from './ui';

interface Data {
  leaders: Array<{ mint: string; symbol: string; source: 'own' | 'dexscreener'; volume1h: number; priceChangeH1Pct: number | null; marketCapUsd: number | null }>;
  narratives: Array<{ word: string; leaders: number }>;
  updatedAt: string | null;
}

export function MarketLeadersCard() {
  const { data } = useApi<Data>('/api/market-leaders', 60_000);
  return (
    <Card title="What's working now" subtitle="Top coins of the last hour (ours + DexScreener). Words they share are hot narratives: new coins matching them score higher.">
      {data && data.narratives.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {data.narratives.map((n) => (
            <span key={n.word} className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-accent/12 px-3 text-sm font-medium text-accent-text">
              {n.word} <span className="tabular text-xs opacity-70">×{n.leaders}</span>
            </span>
          ))}
        </div>
      )}
      {data && data.leaders.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {data.leaders.slice(0, 20).map((l) => (
            <li key={l.mint}>
              <Link to={`/token/${l.mint}`} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm hover:bg-surface-2" title={l.source === 'own' ? 'one of our coins' : 'DexScreener trending'}>
                <span className="font-medium text-ink">{l.symbol}</span>
                <span className="tabular text-xs text-muted">{l.source === 'own' ? `${l.volume1h.toFixed(0)} SOL` : `$${Math.round(l.volume1h / 1000)}k`}</span>
                {l.priceChangeH1Pct !== null && <span className={`tabular text-xs ${l.priceChangeH1Pct >= 0 ? 'text-up' : 'text-down'}`}>{l.priceChangeH1Pct >= 0 ? '+' : ''}{l.priceChangeH1Pct.toFixed(0)}%</span>}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Builds up over the first few minutes after a restart.</Empty>
      )}
    </Card>
  );
}
