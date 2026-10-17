/** Performance page: "What keeps going wrong" — the loss autopsy and the kinds of trades it blocked. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, EXIT_LABEL, STRATEGY_LABEL } from '../lib/format';
import { Badge, Button, Card, Row, Rows, SectionLabel } from './ui';

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
    <Card
      title="What keeps going wrong"
      subtitle={data ? `${data.trades} closed trades checked · ${ago(data.at)}` : undefined}
      action={
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void rerun()}>
          {busy ? 'Checking…' : 'Check now'}
        </Button>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <p className="text-sm text-ink-2">The first check runs a minute after the bot starts, then every 30 minutes.</p>}
      {data && (
        <div className="space-y-6 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Win rate" value={`${data.overall.winRatePct}%`} sub={data.overall.neededWinRatePct !== null ? `needs ${data.overall.neededWinRatePct}% to break even` : undefined} warn={data.overall.neededWinRatePct !== null && data.overall.winRatePct < data.overall.neededWinRatePct} />
            <Tile label="Avg win / avg loss" value={<><span className="text-up">+{data.overall.avgWinPct}%</span> <span className="text-muted">/</span> <span className="text-down">{data.overall.avgLossPct}%</span></>} sub={data.overall.profitFactor !== null ? `profit factor ${data.overall.profitFactor}` : undefined} />
            <Tile label="Losers that never went up" value={`${data.losers.neverUpPct}%`} sub="= bad entries" warn={data.losers.neverUpPct >= 50} />
            <Tile label="Losers that were up 15%+" value={`${data.losers.gaveBackPct}%`} sub="= gave profit back" warn={data.losers.gaveBackPct >= 30} />
          </div>

          {!!data.cards?.length && (
            <section>
              <SectionLabel>Does each strategy deserve to run?</SectionLabel>
              <p className="mb-2 text-xs text-muted">Real trades only, % after every fee. "Profitable" needs 30+ trades, a positive average beyond the noise, still positive without its 3 best trades and in its newest 30%.</p>
              <Rows>
                {data.cards.map((k) => (
                  <Row
                    key={k.strategy}
                    label={
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{strat(k.strategy)}</span>
                        <Badge tone={k.verdict === 'profitable' ? 'up' : k.verdict === 'losing' ? 'down' : 'neutral'}>{k.verdict === 'profitable' ? 'Profitable' : k.verdict === 'losing' ? 'Losing' : 'Not proven yet'}</Badge>
                      </span>
                    }
                    sub={`${k.n} trades · median ${k.medianPct}% · without best 3 ${k.withoutTop3Pct}% · newest 30% ${k.recentPct}% — ${k.why}`}
                    value={<span className={toneOf(k.avgPct)}>{k.avgPct > 0 ? '+' : ''}{k.avgPct}% avg</span>}
                  />
                ))}
              </Rows>
            </section>
          )}

          {!!data.edgeStats?.length && (
            <section>
              <SectionLabel>Expected edge after costs (the edge gate)</SectionLabel>
              <p className="mb-2 text-xs text-muted">Newest trades since this setup went live. Edge = win rate × avg win − loss rate × avg loss − 7% round trip. Under +2% with 30+ trades → the strategy only buys every 4th signal, at the minimum size, until its record improves.</p>
              <Rows>
                {[...data.edgeStats].sort((a, b) => b.n - a.n).map((e) => {
                  const edge = e.winRate * e.avgWinPct - (1 - e.winRate) * Math.abs(e.avgLossPct) - 7;
                  const judged = e.n >= 30;
                  const open = !judged || edge >= 2;
                  return (
                    <Row
                      key={e.strategy}
                      label={strat(e.strategy)}
                      sub={`${e.n} trades · ${Math.round(e.winRate * 100)}% wins · +${e.avgWinPct.toFixed(1)}% / −${Math.abs(e.avgLossPct).toFixed(1)}%`}
                      value={
                        <span className={!judged ? 'text-muted' : open ? 'text-up' : 'text-down'}>
                          {edge >= 0 ? '+' : ''}{edge.toFixed(1)}% <span className="font-normal text-muted">{judged ? (open ? '· open' : '· probes only') : '· not judged yet'}</span>
                        </span>
                      }
                    />
                  );
                })}
              </Rows>
            </section>
          )}

          {data.findings.length > 0 && (
            <section>
              <SectionLabel>Findings</SectionLabel>
              <ul className="space-y-2">
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
            </section>
          )}

          {data.blocked.length > 0 && (
            <section>
              <SectionLabel>
                {data.mode === 'block' ? 'Blocked now' : 'Losing kinds — smallest size only'} ({data.blocked.length})
              </SectionLabel>
              <p className="mb-2 text-xs text-muted">
                {data.mode === 'block'
                  ? 'New buys like these are refused; 1 in 5 still goes through at the smallest size so the bot sees when they start working again.'
                  : 'Still traded (paper keeps collecting data), but only at the smallest size until they start winning again.'}
              </p>
              <SegList rows={data.blocked} />
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionLabel>Losing the most</SectionLabel>
              <SegList rows={data.worst} />
            </section>
            <section>
              <SectionLabel>Working best</SectionLabel>
              {data.best.length ? <SegList rows={data.best} /> : <p className="text-xs text-muted">Nothing clearly profitable yet.</p>}
            </section>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionLabel>By strategy</SectionLabel>
              <Rows>
                {data.byStrategy.map((s) => (
                  <Row key={s.strategy} label={strat(s.strategy)} sub={`${s.n} trades · ${s.winRatePct}% wins · avg ${s.avgPct}%`} value={<span className={toneOf(s.pnlSol)}>{sol(s.pnlSol)}</span>} />
                ))}
              </Rows>
            </section>
            <section>
              <SectionLabel>By how it ended</SectionLabel>
              <Rows>
                {data.byExit.map((e) => (
                  <Row key={e.reason} label={EXIT_LABEL[e.reason] ?? e.reason} sub={`${e.n} trades · avg ${e.avgPct}%`} value={<span className={toneOf(e.pnlSol)}>{sol(e.pnlSol)}</span>} />
                ))}
              </Rows>
            </section>
          </div>
        </div>
      )}
    </Card>
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

function Tile({ label, value, sub, warn }: { label: string; value: React.ReactNode; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
      <div className="truncate text-xs font-medium text-muted">{label}</div>
      <div className={`tabular mt-1 truncate text-lg font-semibold leading-tight ${warn ? 'text-down' : 'text-ink'}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
