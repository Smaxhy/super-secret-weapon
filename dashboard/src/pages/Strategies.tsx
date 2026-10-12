/**
 * Strategies: every chart strategy the bot knows (Fibonacci, EMA pullbacks, breakouts,
 * divergences, order flow …), explained in plain words, with its LIVE record — each one is
 * paper-tested on real coins against random entries. Only strategies that beat random entries
 * on enough trades get a say in real buys. Also the exit-setup lab.
 */
import { Fragment, useState } from 'react';
import { StrategyLab } from '../components/StrategyLab';
import { Card, Empty, ErrorBox, Loading, PageHeader, Stack, Tabs } from '../components/ui';
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
  big?: Stats;
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
  const [tf, setTf] = useState<'all' | '15s' | '5s' | '1m'>('all');
  const tfOf = (id: string) => (id.endsWith('@5s') ? '5s' : id.endsWith('@1m') ? '1m' : '15s');
  if (loading && !data) return <Loading />;
  const shown = data?.strategies.filter((r) => tf === 'all' || tfOf(r.id) === tf) ?? [];
  return (
    <>
      <PageHeader title="Strategies" subtitle="Chart strategies paper-tested on live coins. Only ones that beat random entries get a say in real buys." />
      {error && <ErrorBox message={error} />}
      {data && !data.enabled && <Empty>The chart-strategy lab is switched off (config: ta.labEnabled).</Empty>}
      <Stack>
      {data?.enabled && (
        <Card title="Live test results" subtitle={`${data.open} test trades open · ${data.stats.signals.toLocaleString()} signals so far`}>
          <details className="mb-3 text-sm text-ink-2">
            <summary className="cursor-pointer select-none font-medium text-accent">How the test works</summary>
            <p className="mt-2">
            Every 15 seconds the bot checks the most active coins with every strategy on 15 s, 5 s and 1 min candles ({data.strategies.length} tests in all). Each signal is traded on paper with the bot's real exits and fees.
            The <b>random entry</b> row is the yardstick: a strategy is <b>proven</b> after {data.minTrades}+ tests if it makes money and beats random entries by {data.minEdgePct}+ points per trade.
            </p>
          </details>
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
          <Tabs
            className="mb-3"
            label="Candle timeframe"
            value={tf}
            onChange={setTf}
            tabs={[
              { key: 'all', label: 'All' },
              { key: '15s', label: '15 s' },
              { key: '5s', label: '5 s' },
              { key: '1m', label: '1 min' },
            ]}
          />
          {/* Phones: one compact row per strategy (tap for details) */}
          <ul className="-my-1 divide-y divide-line md:hidden">
            {shown.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} className="flex w-full items-start justify-between gap-3 py-2.5 text-left">
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{r.name}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      {FAMILY[r.family] ?? r.family}
                      <Status r={r} minTrades={data.minTrades} />
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={`tabular block text-sm font-semibold ${r.n ? tone(r.avgPnlPct) : 'text-muted'}`}>{r.n ? signed(r.avgPnlPct) : '—'}</span>
                    <span className="tabular block text-xs text-muted">{r.n ? `${r.n} tests · ${r.winRate.toFixed(0)}% wins` : 'no tests yet'}</span>
                  </span>
                </button>
                {open === r.id && (
                  <div className="pb-3 text-sm text-ink-2">
                    <p className="mb-1">{r.summary}</p>
                    <p className="text-xs text-muted">
                      vs random {r.edgePct === null ? '—' : signed(r.edgePct)} · curve {r.curve.n} tests {r.curve.n ? signed(r.curve.avgPnlPct) : ''} · migrated {r.amm.n} tests {r.amm.n ? signed(r.amm.avgPnlPct) : ''}
                      {r.big ? ` · bigger coins ${r.big.n} tests ${r.big.n ? signed(r.big.avgPnlPct) : ''}` : ''}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
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
                {shown.map((r) => (
                  <Fragment key={r.id}>
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
                            {r.big ? ` · Bigger coins (swing exits): ${r.big.n} tests, ${r.big.n ? signed(r.big.avgPnlPct) : '—'}` : ''}
                            {r.n ? ` · avg win ${signed(r.avgWinPct)} / avg loss ${signed(r.avgLossPct)}` : ''}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">Tap a strategy to see what it looks for.</p>
        </Card>
      )}
      <StrategyLab />
      </Stack>
    </>
  );
}
