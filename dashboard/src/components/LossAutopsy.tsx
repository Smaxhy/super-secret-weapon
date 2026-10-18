/** Performance page: "What keeps going wrong" — the loss autopsy and the kinds of trades it blocked. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, EXIT_LABEL, STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { Badge, Button, Card, Empty, ErrorBox, Row, Rows, SectionHeader, StatTile } from './ui';

interface Rec { n: number; wins: number; winRatePct: number; pnlSol: number; avgPct: number; medianPct: number }
interface Seg extends Rec { strategy: string; band: string; key: string }
interface Autopsy {
  at: string;
  mode?: 'small' | 'block';
  trades: number;
  overall: Rec & { avgWinPct: number; avgLossPct: number; neededWinRatePct: number | null; profitFactor: number | null };
  byStrategy: Array<Rec & { strategy: string }>;
  byExit: Array<{ reason: string; n: number; pnlSol: number; avgPct: number }>;
  cards?: Array<{ strategy: string; n: number; avgPct: number; medianPct: number; sePct: number; withoutTop3Pct: number; recentPct: number; neverUpPct: number; gaveBackPct: number; verdict: 'profitable' | 'losing' | 'unproven'; why: string }>;
  losers: { n: number; neverUpPct: number; gaveBackPct: number; avgPeakMultiple: number };
  /** The record the edge gate judges each strategy by (newest trades since the current setup went live). */
  edgeStats?: Array<{ strategy: string; winRate: number; avgWinPct: number; avgLossPct: number; n: number }>;
  findings: string[];
  worst: Seg[];
  best: Seg[];
  blocked: Seg[];
}

const sol = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(3)} SOL`;
const strat = (s: string) => STRATEGY_LABEL[s] ?? s;
const toneOf = (n: number) => (n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-ink-2');

export function LossAutopsy() {
  const { data, error, reload } = useApi<Autopsy | null>('/api/autopsy', 60_000, ['trade']);
  const [busy, setBusy] = useState(false);
  const rerun = async () => {
    setBusy(true);
    try {
      await api('/api/autopsy/run', { method: 'POST' });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="What keeps going wrong"
        description={data ? `${data.trades} closed trades checked · ${ago(data.at)}. Judge each strategy here and switch losers off.` : 'The loss report runs a minute after start, then every 30 minutes.'}
        action={
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void rerun()}>
            <Icon name="refresh" size={14} />
            {busy ? 'Checking…' : 'Check now'}
          </Button>
        }
      />
      {error && <ErrorBox message={error} />}
      {!data && !error && <Empty>No loss report yet.</Empty>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile compact label="Win rate" value={`${data.overall.winRatePct}%`} sub={data.overall.neededWinRatePct !== null ? `needs ${data.overall.neededWinRatePct}% to break even` : undefined} tone={data.overall.neededWinRatePct !== null && data.overall.winRatePct < data.overall.neededWinRatePct ? 'down' : undefined} />
            <StatTile compact label="Avg win / loss" value={<span className="text-lg"><span className="text-up">+{data.overall.avgWinPct}%</span> <span className="text-muted">/</span> <span className="text-down">{data.overall.avgLossPct}%</span></span>} sub={data.overall.profitFactor !== null ? `profit factor ${data.overall.profitFactor}` : undefined} />
            <StatTile compact label="Losers never up" value={`${data.losers.neverUpPct}%`} sub="= bad entries" tone={data.losers.neverUpPct >= 50 ? 'down' : undefined} />
            <StatTile compact label="Losers once up 15%+" value={`${data.losers.gaveBackPct}%`} sub="= gave profit back" tone={data.losers.gaveBackPct >= 30 ? 'down' : undefined} />
          </div>

          <div className="grid gap-6 xl:grid-cols-12">
            <div className="flex min-w-0 flex-col gap-6 xl:col-span-7">
              {!!data.cards?.length && (
                <Card title="Does each strategy deserve to run?" subtitle={'Real trades only, % after every fee. "Profitable" needs 30+ trades, a positive average beyond the noise, still positive without its 3 best trades and in its newest 30%.'}>
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {data.cards.map((k) => (
                      <li key={k.strategy} className={`min-w-0 rounded-xl border p-3 ${k.verdict === 'profitable' ? 'border-good/40 bg-good/5' : k.verdict === 'losing' ? 'border-critical/40 bg-critical/5' : 'border-line bg-surface-2/40'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-semibold text-ink">{strat(k.strategy)}</span>
                          <Badge tone={k.verdict === 'profitable' ? 'up' : k.verdict === 'losing' ? 'down' : 'neutral'}>{k.verdict === 'profitable' ? 'Profitable' : k.verdict === 'losing' ? 'Losing' : 'Not proven'}</Badge>
                        </div>
                        <div className={`tabular mt-2 text-2xl font-bold leading-none ${toneOf(k.avgPct)}`}>{k.avgPct > 0 ? '+' : ''}{k.avgPct}%<span className="ml-1 text-xs font-medium text-muted">avg</span></div>
                        <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                          <Mini label="Trades" value={k.n} />
                          <Mini label="Median" value={`${k.medianPct}%`} />
                          <Mini label="No best 3" value={`${k.withoutTop3Pct}%`} />
                          <Mini label="Newest 30%" value={`${k.recentPct}%`} />
                          <Mini label="Never up" value={`${k.neverUpPct}%`} />
                          <Mini label="Gave back" value={`${k.gaveBackPct}%`} />
                        </dl>
                        <p className="mt-2 line-clamp-2 text-xs text-muted" title={k.why}>{k.why}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {!!data.edgeStats?.length && (
                <Card title="Expected edge after costs" subtitle="Edge = win rate × avg win − loss rate × avg loss − 7% round trip. Under +2% with 30+ trades → only every 4th signal buys, at the minimum size.">
                  <div className="overflow-x-auto">
                    <table className="tabular w-full min-w-[30rem] text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted">
                          <th className="py-2 font-medium">Strategy</th>
                          <th className="py-2 text-right font-medium">Trades</th>
                          <th className="py-2 text-right font-medium">Wins</th>
                          <th className="py-2 text-right font-medium">Avg win / loss</th>
                          <th className="py-2 text-right font-medium">Edge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...data.edgeStats].sort((a, b) => b.n - a.n).map((e) => {
                          const edge = e.winRate * e.avgWinPct - (1 - e.winRate) * Math.abs(e.avgLossPct) - 7;
                          const judged = e.n >= 30;
                          const open = !judged || edge >= 2;
                          return (
                            <tr key={e.strategy} className="border-t border-line">
                              <td className="py-2 text-ink">{strat(e.strategy)}</td>
                              <td className="py-2 text-right text-ink-2">{e.n}</td>
                              <td className="py-2 text-right text-ink-2">{Math.round(e.winRate * 100)}%</td>
                              <td className="py-2 text-right text-ink-2">+{e.avgWinPct.toFixed(1)}% / −{Math.abs(e.avgLossPct).toFixed(1)}%</td>
                              <td className="py-2 text-right">
                                <span className={!judged ? 'text-muted' : open ? 'text-up' : 'text-down'}>{edge >= 0 ? '+' : ''}{edge.toFixed(1)}%</span>
                                <div className="text-xs text-muted">{judged ? (open ? 'open' : 'probes only') : 'not judged yet'}</div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
              <div className="grid gap-6 lg:grid-cols-2">
                <Card title="By strategy">
                  <Rows>
                    {data.byStrategy.map((s) => (
                      <Row key={s.strategy} label={strat(s.strategy)} sub={`${s.n} trades · ${s.winRatePct}% wins · avg ${s.avgPct}%`} value={<span className={toneOf(s.pnlSol)}>{sol(s.pnlSol)}</span>} />
                    ))}
                  </Rows>
                </Card>
                <Card title="By how it ended">
                  <Rows>
                    {data.byExit.map((e) => (
                      <Row key={e.reason} label={EXIT_LABEL[e.reason] ?? e.reason} sub={`${e.n} trades · avg ${e.avgPct}%`} value={<span className={toneOf(e.pnlSol)}>{sol(e.pnlSol)}</span>} />
                    ))}
                  </Rows>
                </Card>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-6 xl:col-span-5">
              {data.findings.length > 0 && (
                <Card title="Findings">
                  <ul className="space-y-2 text-sm">
                    {data.findings.map((f) => {
                      const warn = f.startsWith('BLOCKED') || f.startsWith('SMALLEST');
                      return (
                        <li key={f} className={`flex gap-2.5 rounded-xl px-3 py-2.5 leading-relaxed ${warn ? 'bg-warning/10 text-ink' : 'bg-surface-2/60 text-ink'}`}>
                          <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${warn ? 'bg-warning' : 'bg-accent'}`} aria-hidden="true" />
                          <span className="min-w-0 break-words">{f}</span>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
              {data.blocked.length > 0 && (
                <Card title={`${data.mode === 'block' ? 'Blocked now' : 'Smallest size only'} (${data.blocked.length})`} subtitle={data.mode === 'block' ? 'Refused; 1 in 5 still goes through small so the bot sees when they start working.' : 'Still traded, but only at the smallest size until they start winning again.'}>
                  <SegList rows={data.blocked} />
                </Card>
              )}
              <Card title="Losing the most">
                <SegList rows={data.worst} />
              </Card>
              <Card title="Working best">{data.best.length ? <SegList rows={data.best} /> : <p className="text-sm text-muted">Nothing clearly profitable yet.</p>}</Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted">{label}</dt>
      <dd className="tabular truncate font-medium text-ink">{value}</dd>
    </div>
  );
}

function SegList({ rows }: { rows: Seg[] }) {
  return (
    <Rows>
      {rows.map((s) => (
        <Row key={s.key} label={<span className="text-ink">{strat(s.strategy)} <span className="text-muted">·</span> {s.band}</span>} sub={`${s.n} trades · ${s.winRatePct}% wins · avg ${s.avgPct}%`} value={<span className={toneOf(s.pnlSol)}>{sol(s.pnlSol)}</span>} />
      ))}
    </Rows>
  );
}

