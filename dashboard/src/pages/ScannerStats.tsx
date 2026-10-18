/**
 * Scanner — a monitoring board.
 *  - Status strip (always on top): stream speed, last hour of buying, tape, wallet book, usage.
 *  - Board: a funnel per strategy (grid of steppers), why coins were skipped / refused (ranked bars),
 *    the bot process and the stream / RPC usage.
 *  - Market: launches, completion rates, launch + score charts, what's working now (chips), hot words.
 *  - Trending: three columns — pump.fun live · other lists · DexScreener.
 */
import { CountBars } from '../components/Charts';
import { MarketLeadersCard } from '../components/MarketLeaders';
import { StatusStrip, StrategyFunnelGrid, SystemDetails, type SystemData, type UpdateInfo } from '../components/SystemHealth';
import { TrendingBoard } from '../components/TrendingTabs';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader, RankedBars, Row, Rows, SectionHeader, StatTile, Tabs, useTab } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useStreamRates } from '../hooks/useStreamRates';
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
  { key: 'health', label: 'Board' },
  { key: 'market', label: 'Market' },
  { key: 'trending', label: 'Trending' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export function ScannerStats() {
  const { data: d, error, loading } = useApi<ScannerStatsData>('/api/scanner-stats', 30_000, ['token']);
  const sys = useApi<SystemData>('/api/system', 30_000);
  const upd = useApi<UpdateInfo>('/api/update', 120_000);
  const rates = useStreamRates();
  const [tab, setTab] = useTab<Tab>('scanner', TABS.map((t) => t.key), 'health');
  if (loading && !d && !sys.data) return <Loading />;
  const t = sys.data?.trading;
  return (
    <>
      <PageHeader title="Scanner" subtitle={t?.summary ?? 'Bot health and what is happening on Pump.fun.'} />
      {(error || sys.error) && <ErrorBox message={(error ?? sys.error)!} />}
      <div className="mb-6">
        <StatusStrip data={sys.data ?? null} tradesPerMin={rates.tradesPerMin} launchesPerMin={rates.launchesPerMin} />
      </div>
      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} sticky label="Scanner sections" />

      {tab === 'health' && (
        <div className="flex flex-col gap-8">
          {t?.strategies && t.strategies.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionHeader title="Strategies (last hour)" description="How far each strategy's coins got: checked → passed the rules → buy signal → bought." action={t.lastHour.entries ? <Badge tone="up">{t.lastHour.entries} bought</Badge> : <Badge tone="warn">no buys</Badge>} />
              <StrategyFunnelGrid rows={t.strategies} />
            </section>
          )}
          <section className="flex flex-col gap-3">
            <SectionHeader title="Why it didn't buy" description="The rule each coin failed first, and why signals that passed were refused." />
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Skipped (last hour)" subtitle="First rule each coin failed">
                {t?.topSkips.length ? <RankedBars rows={t.topSkips.map((r) => ({ label: r.reason, count: r.count }))} /> : <p className="text-sm text-muted">Nothing skipped yet.</p>}
              </Card>
              <Card title="Refused (last hour)" subtitle="Passed every rule, the trader said no">
                {t?.topRefusals.length ? <RankedBars rows={t.topRefusals.map((r) => ({ label: r.reason, count: r.count }))} tone="muted" /> : <p className="text-sm text-muted">No refusals.</p>}
              </Card>
              <Card title="Failed rules (24 h)" subtitle="One coin can fail several">
                {d?.skipReasons.length ? <RankedBars rows={d.skipReasons.slice(0, 10).map((r) => ({ label: REASON_LABEL[r.reason] ?? r.reason, count: r.tokens }))} /> : <p className="text-sm text-muted">No coins scored in the last 24 h yet.</p>}
              </Card>
            </div>
          </section>
          <section className="flex flex-col gap-3">
            <SectionHeader title="System" description="The bot process, the trade stream and RPC calls." />
            <div className="grid gap-4 lg:grid-cols-2">
              {sys.data ? <SystemDetails data={sys.data} upd={upd.data} /> : <Loading kind="rows" />}
              <div className="flex flex-col gap-4">
                <Card title="Trade stream">
                  <Rows>
                    <Row label="Scanner" value={d?.scanner?.connected ? 'Connected' : 'Offline'} tone={d?.scanner?.connected ? undefined : 'down'} />
                    <Row label="Reconnects" value={d?.scanner ? num(d.scanner.reconnects) : '—'} />
                    <Row label="Decode errors" value={d?.scanner ? num(d.scanner.decodeErrors) : '—'} />
                  </Rows>
                </Card>
                {d && (
                  <Card title="Helius RPC calls" subtitle="Calls the bot made, not exact credits. Your real balance is on dashboard.helius.dev.">
                    <div className="mb-3 grid grid-cols-2 gap-3">
                      <StatTile compact label="Today (UTC)" value={num(d.rpc.today)} />
                      <StatTile compact label="Est. per month" value={num(d.rpc.estMonth)} />
                    </div>
                    <RankedBars
                      tone="muted"
                      rows={Object.entries(d.rpc.byMethodToday)
                        .filter(([k]) => k !== '_total')
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8)
                        .map(([k, v]) => ({ label: <span className="font-mono text-xs">{k}</span>, count: v }))}
                    />
                  </Card>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {tab === 'market' && (
        <div className="flex flex-col gap-6">
          {d ? (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile compact label="Launches (24 h)" value={num(d.launches24h)} />
                <StatTile compact label="Launches (7 d)" value={num(d.launches7d)} />
                <StatTile compact label="Completed curve (7 d)" value={pct(d.completionRate7d, 2)} sub="filled the bonding curve" />
                <StatTile compact label="Flagged dangerous (7 d)" value={pct(d.flaggedRate7d, 1)} sub="failed a hard safety check" />
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                <Card title="Launches per hour" subtitle="Last 24 h">
                  <CountBars data={d.launchesPerHour} labelKey="hour" valueLabel="Launches" height={200} tickFormatter={(h) => new Date(h).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} />
                </Card>
                <Card title="Score distribution" subtitle="7 days · coins that reached a scoring checkpoint">
                  <CountBars data={d.scoreHistogram} labelKey="range" valueLabel="Tokens" height={200} />
                </Card>
              </div>
              <MarketLeadersCard />
              <Card title="Hot keywords from X">
                {d.hotKeywords?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {d.hotKeywords.map((k) => (
                      <span key={k} className="rounded-full border border-line bg-surface-2 px-3 py-1 text-sm text-ink">{k}</span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-ink-2">None right now. Needs an X API key (TWITTER_BEARER_TOKEN in the VPS .env). Your own boost words on Controls always apply.</p>
                )}
              </Card>
            </>
          ) : (
            <Empty>Market stats are loading.</Empty>
          )}
        </div>
      )}

      {tab === 'trending' && <TrendingBoard />}
    </>
  );
}
