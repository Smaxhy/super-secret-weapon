/**
 * Trending tabs (Scanner page): coins on pump.fun's own tabs (live streams with real viewer
 * counts, King of the Hill, for-you, top runners) and GeckoTerminal's trending pools, plus the
 * health of each feed and DexScreener's trending narratives.
 */
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { Card } from './ui';

interface Coin {
  mint: string;
  symbol: string;
  name: string;
  rank: number;
  usdMarketCap: number | null;
  viewers: number | null;
  live: boolean;
  complete: boolean | null;
  banned: boolean;
  mayhem: boolean;
  sources: string[];
}
interface Health {
  source: string;
  ok: boolean;
  coins: number;
  updatedAt: string | null;
  pausedUntil: string | null;
  error: string | null;
}

const LABEL: Record<string, string> = {
  pump_live: 'live',
  pump_koth: 'KOTH',
  pump_for_you: 'for you',
  pump_runners: 'runners',
  gecko_5m: 'Gecko 5m',
  gecko_1h: 'Gecko 1h',
  dex_metas: 'Dex narratives',
};
const k = (n: number | null) => (n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);

export function TrendingTabs() {
  const { data } = useApi<{ coins: Coin[]; health: Health[]; narratives: string[] }>('/api/trending', 30_000);
  if (!data) return null;
  return (
    <Card title="Trending tabs" className="mt-4">
      <p className="mb-2 text-sm text-ink-2">
        What pump.fun and GeckoTerminal show as trending right now. A coin new on a tab is checked straight away (never bought just for trending — lists usually catch a coin
        after its move) and the Strategies lab measures whether those entries pay.
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
        {data.health.map((h) => (
          <span key={h.source} title={h.error ?? (h.updatedAt ? `updated ${new Date(h.updatedAt).toLocaleTimeString()}` : 'not yet')} className={`rounded border px-1.5 py-0.5 ${h.ok ? 'border-up/40 text-up' : h.pausedUntil ? 'border-line text-muted' : 'border-down/40 text-down'}`}>
            {LABEL[h.source] ?? h.source}: {h.ok ? h.coins : h.pausedUntil ? 'paused' : 'no data'}
          </span>
        ))}
      </div>
      {data.narratives.length > 0 && <p className="mb-2 text-xs text-ink-2">Trending narratives: {data.narratives.join(', ')}</p>}
      {data.coins.length > 0 ? (
        <ul className="divide-y divide-line text-sm">
          {data.coins.slice(0, 25).map((c) => (
            <li key={c.mint} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <Link to={`/token/${c.mint}`} className="truncate font-semibold text-ink hover:underline">
                  {c.symbol || c.mint.slice(0, 6)}
                </Link>
                {c.live && <span className="shrink-0 rounded bg-down/15 px-1 text-xs text-down">● live{c.viewers !== null ? ` ${c.viewers}` : ''}</span>}
                {(c.banned || c.mayhem) && <span className="shrink-0 rounded border border-down/40 px-1 text-xs text-down">{c.banned ? 'banned' : 'mayhem'}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-ink-2">
                <span>{k(c.usdMarketCap)}</span>
                <span className="text-muted">{c.sources.map((s) => LABEL[s] ?? s).join(' · ')}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No trending data yet (feeds start within a minute of the bot starting).</p>
      )}
    </Card>
  );
}
