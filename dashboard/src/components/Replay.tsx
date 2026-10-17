/**
 * Performance → Tests: "Replay" — the bot's rules run over the recorded market (TradeTape) in a child process on
 * the VPS. POST /api/replay starts one, GET /api/replay has the running job, the last report and recent runs.
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { Badge, Button, Card, inputCls, RankedBars, Row, Rows, SectionLabel } from './ui';

interface Trade { symbol: string; strategy: string; pnlPct: number; pnlSol: number; peakX: number; holdSec: number; reason: string; score: number }
interface Report {
  id: string;
  at: string;
  from: string;
  to: string;
  policy: string;
  rows: number;
  coins: number;
  evaluated: number;
  signals: number;
  trades: number;
  winRatePct: number;
  totalSol: number;
  avgPct: number;
  medianPct: number;
  profitFactor: number | null;
  sizeSol: number;
  byStrategy: Array<{ strategy: string; n: number; winRatePct: number; totalSol: number; avgPct: number }>;
  byExit: Array<{ reason: string; n: number; totalSol: number; avgPct: number }>;
  skips: Array<{ reason: string; count: number }>;
  worst: Trade[];
  best: Trade[];
  durationMs: number;
  note: string;
}
interface Job { id: string; startedAt: string; log: string[]; finishedAt: string | null; exitCode: number | null }
interface Status {
  running: Job | null;
  lastJob: Job | null;
  last: Report | null;
  history: Array<{ id: string; at: string; from: string; to: string; policy: string; trades: number; winRatePct: number; totalSol: number; avgPct: number }>;
}

const sol = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(3)} SOL`;
const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const local = (ms: number) => {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};
const strat = (s: string) => STRATEGY_LABEL[s] ?? s;

export function Replay() {
  const { data, error, reload } = useApi<Status | null>('/api/replay', 0);
  const [from, setFrom] = useState(() => local(Date.now() - 86_400_000));
  const [to, setTo] = useState(() => local(Date.now()));
  const [policy, setPolicy] = useState<'live' | 'sniper'>('live');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = !!data?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 5_000);
    return () => clearInterval(t);
  }, [running, reload]);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/api/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), policy }) });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const r = data?.last ?? null;
  return (
    <Card title="Replay the rules over the recorded market" subtitle="Every trade on every coin is recorded. A replay runs the bot's entry rules and exits over those days in minutes — a number instead of a week of waiting.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
          Rules
          <select value={policy} onChange={(e) => setPolicy(e.target.value as 'live' | 'sniper')} className={inputCls}>
            <option value="live">Live rules (as the bot trades now)</option>
            <option value="sniper">Sniper (fewer, bigger trades)</option>
          </select>
        </label>
        <Button disabled={busy || running} onClick={() => void run()} className="col-span-2 sm:col-span-1">
          <Icon name="play" size={15} />
          {running ? 'Running…' : 'Run replay'}
        </Button>
      </div>
      {(error || err) && <p className="mt-3 text-sm text-down">{error ?? err}</p>}
      {data?.running && (
        <div className="fade-in mt-4 rounded-xl border border-line bg-surface-2/50 p-3 text-xs text-muted">
          <div className="mb-1 flex items-center gap-2 font-medium text-ink">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            Replaying since {new Date(data.running.startedAt).toLocaleTimeString()}…
          </div>
          {data.running.log.slice(-3).map((l, i) => (
            <div key={i} className="truncate">{l}</div>
          ))}
        </div>
      )}
      {data?.lastJob && data.lastJob.exitCode !== 0 && data.lastJob.exitCode !== null && !data.running && (
        <p className="mt-3 text-sm text-down">The last replay failed: {data.lastJob.log.slice(-2).join(' · ') || `exit code ${data.lastJob.exitCode}`}</p>
      )}
      {r ? (
        <div className="mt-5 flex flex-col gap-5">
          <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone="accent">{r.policy} rules</Badge>
              <span>
                {new Date(r.from).toLocaleString()} → {new Date(r.to).toLocaleString()}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={`tabular text-3xl font-bold tracking-tight ${tone(r.totalSol)}`}>{sol(r.totalSol)}</span>
              <span className="text-sm text-ink-2">
                on {r.trades} trades · {r.winRatePct}% wins · {r.sizeSol} SOL each
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Mini label="Avg per trade" value={<span className={tone(r.avgPct)}>{pct(r.avgPct)}</span>} />
              <Mini label="Median" value={<span className={tone(r.medianPct)}>{pct(r.medianPct)}</span>} />
              <Mini label="Profit factor" value={r.profitFactor !== null ? r.profitFactor.toFixed(2) : '—'} />
              <Mini label="Buy signals" value={r.signals.toLocaleString()} />
            </dl>
            <p className="mt-3 text-xs text-muted">
              {r.rows.toLocaleString()} recorded trades on {r.coins.toLocaleString()} coins · {r.evaluated.toLocaleString()} checks · took {(r.durationMs / 1000).toFixed(0)} s
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {r.byStrategy.length > 0 && (
              <div>
                <SectionLabel>By strategy</SectionLabel>
                <Rows>
                  {r.byStrategy.map((s) => (
                    <Row key={s.strategy} label={strat(s.strategy)} sub={`${s.n} trades · ${s.winRatePct}% wins · avg ${pct(s.avgPct)}`} value={<span className={tone(s.totalSol)}>{sol(s.totalSol)}</span>} />
                  ))}
                </Rows>
              </div>
            )}
            {r.byExit.length > 0 && (
              <div>
                <SectionLabel>By exit</SectionLabel>
                <Rows>
                  {r.byExit.map((e) => (
                    <Row key={e.reason} label={e.reason} sub={`${e.n} · avg ${pct(e.avgPct)}`} value={<span className={tone(e.totalSol)}>{sol(e.totalSol)}</span>} />
                  ))}
                </Rows>
              </div>
            )}
          </div>

          {r.skips.length > 0 && (
            <div>
              <SectionLabel>Why it did not buy (top reasons)</SectionLabel>
              <RankedBars rows={r.skips.map((s) => ({ label: s.reason, count: s.count }))} />
            </div>
          )}

          {(r.worst.length > 0 || r.best.length > 0) && (
            <div className="grid gap-5 sm:grid-cols-2">
              {[{ label: 'Best', xs: r.best }, { label: 'Worst', xs: r.worst }].map((g) => (
                <div key={g.label}>
                  <SectionLabel>{g.label}</SectionLabel>
                  <Rows>
                    {g.xs.map((t, i) => (
                      <Row key={`${t.symbol}-${i}`} label={t.symbol || '?'} sub={`${strat(t.strategy)} · ${t.reason} · peak ${t.peakX}×`} value={<span className={tone(t.pnlSol)}>{pct(t.pnlPct)}</span>} />
                    ))}
                  </Rows>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted">{r.note}</p>
        </div>
      ) : (
        !data?.running && <p className="mt-4 text-sm text-muted">No replay yet. Recording starts with this update — give it a few hours of tape, then press Run.</p>
      )}
      {!!data?.history?.length && (
        <div className="mt-5">
          <SectionLabel>Recent runs</SectionLabel>
          <Rows>
            {data.history.map((h) => (
              <Row
                key={h.id}
                label={`${new Date(h.at).toLocaleString()} · ${h.policy}`}
                sub={`${new Date(h.from).toLocaleDateString()} → ${new Date(h.to).toLocaleDateString()} · ${h.trades} trades · ${h.winRatePct}% wins`}
                value={<span className={tone(h.totalSol)}>{sol(h.totalSol)}</span>}
              />
            ))}
          </Rows>
        </div>
      )}
    </Card>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="tabular mt-0.5 font-semibold text-ink">{value}</dd>
    </div>
  );
}
