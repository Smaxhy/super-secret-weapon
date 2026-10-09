import { CountBars } from '../components/Charts';
import { Card, ErrorBox, Loading, PageHeader, StatTile } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { num, pct } from '../lib/format';
import type { ScannerStatsData } from '../lib/types';

const REASON_LABEL: Record<string, string> = {
  score: 'Score below 75',
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

export function ScannerStats() {
  const { data: d, error, loading } = useApi<ScannerStatsData>('/api/scanner-stats', 30_000, ['token']);
  if (loading && !d) return <Loading />;
  return (
    <>
      <PageHeader title="Scanner" subtitle="What's happening on Pump.fun overall." />
      {error && <ErrorBox message={error} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="Launches (24h)" value={num(d.launches24h)} />
            <StatTile label="Launches (7d)" value={num(d.launches7d)} />
            <StatTile label="Completed curve (7d)" value={pct(d.completionRate7d, 2)} sub="share that filled the bonding curve" />
            <StatTile label="Flagged dangerous (7d)" value={pct(d.flaggedRate7d, 1)} sub="failed a hard safety check" />
            <StatTile label="Scanner" value={d.scanner?.connected ? '● Connected' : '○ Offline'} sub={d.scanner ? `${d.scanner.reconnects} reconnects · ${d.scanner.decodeErrors} decode errors` : undefined} />
          </div>
          <Card title="Why coins weren't bought (last 24h)" className="mt-4">
            {d.skipReasons.length ? (
              <>
                <ul className="space-y-2">
                  {d.skipReasons.slice(0, 12).map((r) => {
                    const max = d.skipReasons[0]?.tokens || 1;
                    return (
                      <li key={r.reason} className="grid grid-cols-[minmax(8rem,14rem)_1fr_3.5rem] items-center gap-3 text-sm">
                        <span className="text-ink">{REASON_LABEL[r.reason] ?? r.reason}</span>
                        <span className="h-2 rounded-full bg-[color-mix(in_srgb,var(--series-1)_15%,transparent)]">
                          <span className="block h-2 rounded-full bg-[var(--series-1)]" style={{ width: `${(r.tokens / max) * 100}%` }} />
                        </span>
                        <span className="tabular text-right text-ink">{num(r.tokens)}</span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-sm text-muted">Number of coins that failed each rule. One coin can fail several. Only coins that reached 10 holders get checked.</p>
              </>
            ) : (
              <p className="text-ink-2">No coins have been scored in the last 24h yet.</p>
            )}
          </Card>

          <Card title="Helius RPC usage" className="mt-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatTile label="Calls today (UTC)" value={num(d.rpc.today)} />
              <StatTile label="Estimated per month" value={num(d.rpc.estMonth)} sub="based on recent days" />
              <div className="col-span-2 text-sm text-ink-2 sm:col-span-1">
                {Object.entries(d.rpc.byMethodToday)
                  .filter(([k]) => k !== '_total')
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 tabular">
                      <span>{k}</span>
                      <span className="text-ink">{num(v)}</span>
                    </div>
                  ))}
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">Calls the bot made, not exact Helius credits (some methods cost more than 1). Your real balance is on dashboard.helius.dev.</p>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card title="Launches per hour (last 24h)">
              <CountBars data={d.launchesPerHour} labelKey="hour" valueLabel="Launches" tickFormatter={(h) => new Date(h).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} />
            </Card>
            <Card title="Score distribution (7d)">
              <CountBars data={d.scoreHistogram} labelKey="range" valueLabel="Tokens" />
              <p className="mt-2 text-sm text-ink-2">Only tokens that reached a scoring checkpoint. The bot buys at 75+.</p>
            </Card>
          </div>
          <Card title="Market regime" className="mt-4">
            <p className="text-ink-2">{d.regime ?? 'Hot / normal / cold detection arrives with the learning engine (Phase 7).'}</p>
          </Card>
        </>
      )}
    </>
  );
}
