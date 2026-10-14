/** Performance page: "What keeps going wrong" — the loss autopsy and the kinds of trades it blocked. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, EXIT_LABEL, STRATEGY_LABEL } from '../lib/format';
import { Card } from './ui';

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
  findings: string[];
  worst: Seg[];
  best: Seg[];
  blocked: Seg[];
}

const sol = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(3)} SOL`;
const strat = (s: string) => STRATEGY_LABEL[s] ?? s;

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
      action={
        <button type="button" disabled={busy} onClick={() => void rerun()} className="text-sm text-accent hover:underline disabled:opacity-50">
          {busy ? 'Checking…' : 'Check now'}
        </button>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <p className="text-sm text-ink-2">The first check runs a minute after the bot starts, then every 30 minutes.</p>}
      {data && (
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted">{data.trades} closed trades checked · {ago(data.at)}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Win rate" value={`${data.overall.winRatePct}%`} sub={data.overall.neededWinRatePct !== null ? `needs ${data.overall.neededWinRatePct}% to break even` : undefined} warn={data.overall.neededWinRatePct !== null && data.overall.winRatePct < data.overall.neededWinRatePct} />
            <Stat label="Avg win / avg loss" value={`+${data.overall.avgWinPct}% / ${data.overall.avgLossPct}%`} sub={data.overall.profitFactor !== null ? `profit factor ${data.overall.profitFactor}` : undefined} />
            <Stat label="Losers that never went up" value={`${data.losers.neverUpPct}%`} sub="= bad entries" warn={data.losers.neverUpPct >= 50} />
            <Stat label="Losers that were up 15%+" value={`${data.losers.gaveBackPct}%`} sub="= gave profit back" warn={data.losers.gaveBackPct >= 30} />
          </div>
          {!!data.cards?.length && (
            <div>
              <div className="mb-1 font-medium text-ink">Does each strategy deserve to run?</div>
              <p className="mb-1 text-xs text-muted">Real trades only, % after every fee. "Profitable" needs 30+ trades, a positive average beyond the noise, still positive without its 3 best trades and in its newest 30%.</p>
              <ul className="divide-y divide-line text-xs">
                {data.cards.map((k) => (
                  <li key={k.strategy} className="py-1.5">
                    <div className="flex min-w-0 justify-between gap-2">
                      <span className="min-w-0 truncate font-medium text-ink">{strat(k.strategy)}</span>
                      <span className={`shrink-0 font-medium ${k.verdict === 'profitable' ? 'text-up' : k.verdict === 'losing' ? 'text-down' : 'text-muted'}`}>
                        {k.verdict === 'profitable' ? 'Profitable' : k.verdict === 'losing' ? 'Losing' : 'Not proven yet'}
                      </span>
                    </div>
                    <div className="tabular-nums text-ink-2">
                      {k.n} trades · avg {k.avgPct}% · median {k.medianPct}% · without best 3 {k.withoutTop3Pct}% · newest 30% {k.recentPct}%
                    </div>
                    <div className="text-muted">{k.why}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.findings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-ink">
              {data.findings.map((f) => (
                <li key={f} className={f.startsWith('BLOCKED') || f.startsWith('SMALLEST') ? 'text-warning' : undefined}>{f}</li>
              ))}
            </ul>
          )}
          {data.blocked.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-ink">{data.mode === 'block' ? 'Blocked now' : 'Losing kinds — smallest size only'} ({data.blocked.length})</div>
              <p className="mb-1 text-xs text-muted">
                {data.mode === 'block'
                  ? 'New buys like these are refused; 1 in 5 still goes through at the smallest size so the bot sees when they start working again.'
                  : 'Still traded (paper keeps collecting data), but only at the smallest size until they start winning again.'}
              </p>
              <SegList rows={data.blocked} />
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 font-medium text-ink">Losing the most</div>
              <SegList rows={data.worst} />
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">Working best</div>
              {data.best.length ? <SegList rows={data.best} /> : <p className="text-xs text-muted">Nothing clearly profitable yet.</p>}
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Table title="By strategy" rows={data.byStrategy.map((s) => [strat(s.strategy), s.n, `${s.winRatePct}%`, `${s.avgPct}%`, s.pnlSol])} />
            <Table title="By how it ended" rows={data.byExit.map((e) => [EXIT_LABEL[e.reason] ?? e.reason, e.n, '', `${e.avgPct}%`, e.pnlSol])} />
          </div>
        </div>
      )}
    </Card>
  );
}

function SegList({ rows }: { rows: Seg[] }) {
  return (
    <ul className="divide-y divide-line text-xs">
      {rows.map((s) => (
        <li key={s.key} className="flex min-w-0 justify-between gap-2 py-1.5">
          <span className="min-w-0 truncate text-ink">
            {strat(s.strategy)} · {s.band}
          </span>
          <span className="shrink-0 tabular-nums text-ink-2">
            {s.n} trades · {s.winRatePct}% wins · avg {s.avgPct}% · <span className={s.pnlSol >= 0 ? 'text-up' : 'text-down'}>{sol(s.pnlSol)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Table({ title, rows }: { title: string; rows: Array<[string, number, string, string, number]> }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 font-medium text-ink">{title}</div>
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="text-muted"><tr><th className="py-1">Kind</th><th>Trades</th><th>Wins</th><th>Avg</th><th className="text-right">SOL</th></tr></thead>
        <tbody>
          {rows.map(([k, n, w, a, p]) => (
            <tr key={k} className="border-t border-line">
              <td className="py-1 pr-2">{k}</td><td>{n}</td><td>{w}</td><td>{a}</td>
              <td className={`text-right ${p >= 0 ? 'text-up' : 'text-down'}`}>{sol(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-muted">{label}</div>
      <div className={`truncate font-medium tabular-nums ${warn ? 'text-down' : 'text-ink'}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
