import { CountBars } from '../components/Charts';
import { Card, ErrorBox, Loading, PageHeader, StatTile } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { num, pct } from '../lib/format';
import type { ScannerStatsData } from '../lib/types';

export function ScannerStats() {
  const { data: d, error, loading } = useApi<ScannerStatsData>('/api/scanner-stats', 30_000);
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
