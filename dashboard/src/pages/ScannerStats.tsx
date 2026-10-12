import { SystemPanel } from '../components/SystemHealth';
import { DexTrending } from '../components/DexTrending';
import { TrendingTabs } from '../components/TrendingTabs';
import { MarketLeadersCard } from '../components/MarketLeaders';
import { CountBars } from '../components/Charts';
import { Card, ErrorBox, Loading, PageHeader, Row, Rows, Stack, Stat, StatTile, Tabs, useTab } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { num, pct } from '../lib/format';
import type { ScannerStatsData } from '../lib/types';

const REASON_LABEL: Record<string, string> = {
  score: 'Score too low',
  holders: 'Not enough holders',
  MC: 'Market cap under $12k',
  volume: 'Volume under $12k',
  fees: 'Fees paid under 1 SOL',
  curve: 'Bonding curve outside range',
  age: 'Too old (over 15 min)',
  liquidity: 'Too little SOL in curve',
  'dev holds': 'Dev holds too much',
  safety: 'Safety score too low',
  'safety hard fail': 'Failed safety (dangerous)',
  'blocked keyword': 'Blocked keyword',
  'no X link': 'No X link',
  'curve already complete': 'Already migrated',
  'SOL/USD price unknown': 'SOL price unavailable',
};

const TABS = [
  { key: 'health', label: 'Health' },
  { key: 'market', label: 'Market' },
  { key: 'trending', label: 'Trending' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export function ScannerStats() {
  const { data: d, error, loading } = useApi<ScannerStatsData>('/api/scanner-stats', 30_000, ['token']);
  const [tab, setTab] = useTab<Tab>('scanner', TABS.map((t) => t.key), 'health');
  if (loading && !d) return <Loading />;
  return (
    <>
      <PageHeader title="Scanner" subtitle="Bot health and what's happening on Pump.fun." />
      {error && <ErrorBox message={error} />}
      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} sticky label="Scanner sections" />
      {tab === 'health' && (
        <Stack>
          <SystemPanel />
          {d && (
            <>
              <Card title="Why coins weren't bought" subtitle="Last 24 h · coins that failed each rule (one coin can fail several).">
                {d.skipReasons.length ? (
                  <ul className="space-y-2.5">
                    {d.skipReasons.slice(0, 12).map((r) => {
                      const max = d.skipReasons[0]?.tokens || 1;
                      return (
                        <li key={r.reason} className="text-sm">
                          <div className="mb-1 flex items-baseline justify-between gap-3">
                            <span className="min-w-0 truncate text-ink">{REASON_LABEL[r.reason] ?? r.reason}</span>
                            <span className="tabular shrink-0 text-ink-2">{num(r.tokens)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-[color-mix(in_srgb,var(--series-1)_15%,transparent)]">
                            <div className="h-1.5 rounded-full bg-[var(--series-1)]" style={{ width: `${(r.tokens / max) * 100}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-2">No coins have been scored in the last 24h yet.</p>
                )}
              </Card>

              <Card title="Stream" subtitle="The live trade feed from Pump.fun and Solana.">
                <div className="grid grid-cols-2 gap-4">
                  <Stat label="Scanner" value={d.scanner?.connected ? 'Connected' : 'Offline'} tone={d.scanner?.connected ? 'up' : 'down'} />
                  <Stat label="Reconnects / decode errors" value={d.scanner ? `${d.scanner.reconnects} / ${d.scanner.decodeErrors}` : '—'} />
                </div>
              </Card>

              <Card title="Helius RPC usage" subtitle="Calls the bot made (not exact credits). Your real balance is on dashboard.helius.dev.">
                <div className="mb-3 grid grid-cols-2 gap-4">
                  <Stat label="Calls today (UTC)" value={num(d.rpc.today)} />
                  <Stat label="Estimated per month" value={num(d.rpc.estMonth)} />
                </div>
                <Rows>
                  {Object.entries(d.rpc.byMethodToday)
                    .filter(([k]) => k !== '_total')
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <Row key={k} label={<span className="font-mono text-xs">{k}</span>} value={num(v)} />
                    ))}
                </Rows>
              </Card>
            </>
          )}
        </Stack>
      )}
      {tab === 'market' && d && (
        <Stack>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Launches (24h)" value={num(d.launches24h)} />
            <StatTile label="Launches (7d)" value={num(d.launches7d)} />
            <StatTile label="Completed curve (7d)" value={pct(d.completionRate7d, 2)} sub="filled the bonding curve" />
            <StatTile label="Flagged dangerous (7d)" value={pct(d.flaggedRate7d, 1)} sub="failed a hard safety check" />
          </div>
          <Card title="Market regime">
            <p className="text-sm text-ink-2">{d.regime ?? 'Hot / normal / cold detection starts after the first learning run.'}</p>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Launches per hour" subtitle="Last 24 h">
              <CountBars data={d.launchesPerHour} labelKey="hour" valueLabel="Launches" tickFormatter={(h) => new Date(h).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} />
            </Card>
            <Card title="Score distribution" subtitle="7 days · coins that reached a scoring checkpoint">
              <CountBars data={d.scoreHistogram} labelKey="range" valueLabel="Tokens" />
            </Card>
          </div>
          <MarketLeadersCard />
          <Card title="Hot keywords from X">
            {d.hotKeywords?.length ? (
              <div className="flex flex-wrap gap-2">
                {d.hotKeywords.map((k) => (
                  <span key={k} className="rounded-full border border-line bg-surface-2 px-3 py-1 text-sm text-ink">
                    {k}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-2">None right now. Needs an X API key (TWITTER_BEARER_TOKEN in the VPS .env). Your own boost words on Controls always apply.</p>
            )}
          </Card>
        </Stack>
      )}
      {tab === 'trending' && (
        <Stack>
          <TrendingTabs />
          <DexTrending />
        </Stack>
      )}
    </>
  );
}
