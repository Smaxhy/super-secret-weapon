/**
 * Strategies: every chart strategy the bot knows (Fibonacci, EMA pullbacks, breakouts,
 * divergences, order flow …), explained in plain words, with its LIVE record — each one is
 * paper-tested on real coins against random entries. Only strategies that beat random entries
 * on enough trades get a say in real buys. Also the exit-setup lab.
 */
import { useState } from 'react';
import { StrategyLab } from '../components/StrategyLab';
import { Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks/useApi';

interface Stats {
  id: string;
  name: string;
  n: number;
  winRate: number;
  avgPnlPct: number;
  medianPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  lowerPct: number;
}
interface Row extends Stats {
  family: string;
  summary: string;
  proven: boolean;
  edgePct: number | null;
  curve: Stats;
  amm: Stats;
}
interface TaLabData {
  enabled: boolean;
  baseline: Stats | null;
  strategies: Row[];
  open: number;
  stats: { ticks: number; coinsLooked: number; signals: number; opened: number; lastTickMs: number };
  minTrades: number;
  minEdgePct: number;
}

const FAMILY: Record<string, string> = {
  fibonacci: 'Fibonacci',
  trend: 'Trend',
  momentum: 'Momentum',
  'mean-reversion': 'Mean reversion',
  breakout: 'Breakout',
  structure: 'Structure',
  pattern: 'Pattern',
  volume: 'Volume / order flow',
};
const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

function Status({ r, minTrades }: { r: Row; minTrades: number }) {
  if (r.proven) return <span className="rounded bg-up/15 px-1.5 py-0.5 text-xs font-semibold text-up">proven — used in buys</span>;
  if (r.n < minTrades) return <span className="rounded bg-line px-1.5 py-0.5 text-xs text-ink-2">testing {r.n}/{minTrades}</span>;
  return <span className="rounded bg-down/10 px-1.5 py-0.5 text-xs text-down">no edge (yet)</span>;
}

export function Strategies() {
  const { data, error, loading } = useApi<TaLabData>('/api/ta-lab', 30_000);
  const [open, setOpen] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  return (
    <>
      <PageHeader title="Strategies" subtitle="Every chart strategy is paper-tested on live coins. Only the ones that beat random entries get a say in real buys." />
      {error && <ErrorBox message={error} />}
      {data && !data.enabled && <Empty>The chart-strategy lab is switched off (config: ta.labEnabled).</Empty>}
      {data?.enabled && (
        <Card title="Chart strategies — live test results">
          <p className="mb-3 text-sm text-ink-2">
            Every 15 seconds the bot checks the most active coins with all {data.strategies.length} strategies. Each signal is traded on paper with the bot's real exits and fees.
            The <b>random entry</b> row is the yardstick: a strategy is <b>proven</b> after {data.minTrades}+ tests if it makes money and beats random entries by {data.minEdgePct}+ points per trade.
            {` ${data.open} test trades open · ${data.stats.signals.toLocaleString()} signals so far.`}
          </p>
          {data.baseline && (
            <div className="mb-3 rounded-xl border border-line px-3 py-2 text-sm">
              <span className="font-medium text-ink">Random entry (yardstick):</span>{' '}
              {data.baseline.n ? (
                <>
                  {data.baseline.n} tests · {data.baseline.winRate.toFixed(0)}% wins · <span className={tone(data.baseline.avgPnlPct)}>{signed(data.baseline.avgPnlPct)} per trade</span>
                </>
              ) : (
                'collecting…'
              )}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm tabular-nums">
              <thead>
                <tr className="text-left text-ink-2">
                  <th className="pb-2 font-medium">Strategy</th>
                  <th className="pb-2 font-medium">Tests</th>
                  <th className="pb-2 font-medium">Win rate</th>
                  <th className="pb-2 font-medium">Avg / trade</th>
                  <th className="pb-2 font-medium">vs random</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.strategies.map((r) => (
                  <>
                    <tr key={r.id} className="cursor-pointer hover:bg-line/30" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td className="py-2 pr-2">
                        <div className="font-medium text-ink">{r.name}</div>
                        <div className="text-xs text-muted">{FAMILY[r.family] ?? r.family}</div>
                      </td>
                      <td className="py-2">{r.n}</td>
                      <td className="py-2">{r.n ? `${r.winRate.toFixed(0)}%` : '—'}</td>
                      <td className={`py-2 ${tone(r.avgPnlPct)}`}>{r.n ? signed(r.avgPnlPct) : '—'}</td>
                      <td className={`py-2 ${r.edgePct === null ? 'text-ink-2' : tone(r.edgePct)}`}>{r.edgePct === null ? '—' : signed(r.edgePct)}</td>
                      <td className="py-2">
                        <Status r={r} minTrades={data.minTrades} />
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr key={`${r.id}-more`}>
                        <td colSpan={6} className="pb-3 pt-1 text-sm text-ink-2">
                          <p className="mb-1">{r.summary}</p>
                          <p className="text-xs text-muted">
                            On the curve: {r.curve.n} tests, {r.curve.n ? signed(r.curve.avgPnlPct) : '—'} · Migrated: {r.amm.n} tests, {r.amm.n ? signed(r.amm.avgPnlPct) : '—'}
                            {r.n ? ` · avg win ${signed(r.avgWinPct)} / avg loss ${signed(r.avgLossPct)}` : ''}
                          </p>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">Tap a strategy to see what it looks for.</p>
        </Card>
      )}
      <StrategyLab />
    </>
  );
}
