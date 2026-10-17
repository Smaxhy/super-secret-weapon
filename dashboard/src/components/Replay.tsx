/**
 * Performance → Tests: "Replay" — the bot's rules run over the recorded market (TradeTape) in a child process on
 * the VPS. POST /api/replay starts one, GET /api/replay has the running job, the last report and recent runs.
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { STRATEGY_LABEL } from '../lib/format';
import { Card } from './ui';

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
    <Card title="Replay: the rules over the recorded market" subtitle="Every trade on every coin is recorded. A replay runs the bot's entry rules and exits over those days in minutes — a number instead of a week of waiting.">
      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col text-xs text-muted">
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-line bg-page px-2 py-1 text-sm text-ink" />
        </label>
        <label className="flex flex-col text-xs text-muted">
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-line bg-page px-2 py-1 text-sm text-ink" />
        </label>
        <label className="flex flex-col text-xs text-muted">
          Rules
          <select value={policy} onChange={(e) => setPolicy(e.target.value as 'live' | 'sniper')} className="rounded-lg border border-line bg-page px-2 py-1 text-sm text-ink">
            <option value="live">Live rules (as the bot trades now)</option>
            <option value="sniper">Sniper (fewer, bigger trades)</option>
          </select>
        </label>
        <button type="button" disabled={busy || running} onClick={() => void run()} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {running ? 'Running…' : 'Run replay'}
        </button>
      </div>
      {(error || err) && <p className="text-sm text-down">{error ?? err}</p>}
      {data?.running && (
        <div className="mb-3 rounded-lg border border-line bg-page p-2 text-xs text-muted">
          Replaying since {new Date(data.running.startedAt).toLocaleTimeString()}…
          {data.running.log.slice(-3).map((l, i) => (
            <div key={i} className="truncate">{l}</div>
          ))}
        </div>
      )}
      {data?.lastJob && data.lastJob.exitCode !== 0 && data.lastJob.exitCode !== null && !data.running && (
        <p className="mb-2 text-sm text-down">The last replay failed: {data.lastJob.log.slice(-2).join(' · ') || `exit code ${data.lastJob.exitCode}`}</p>
      )}
      {r ? (
        <>
          <p className="mb-2 text-sm text-ink">
            With the <span className="font-medium">{r.policy}</span> rules over {new Date(r.from).toLocaleString()} → {new Date(r.to).toLocaleString()}: <span className={`font-semibold ${tone(r.totalSol)}`}>{sol(r.totalSol)}</span> on {r.trades} trades, {r.winRatePct}% wins (avg {pct(r.avgPct)}, median {pct(r.medianPct)}{r.profitFactor !== null ? `, profit factor ${r.profitFactor}` : ''}), {r.sizeSol} SOL each.
          </p>
          <p className="mb-3 text-xs text-muted">
            {r.rows.toLocaleString()} recorded trades on {r.coins.toLocaleString()} coins · {r.evaluated.toLocaleString()} checks · {r.signals} buy signals · took {(r.durationMs / 1000).toFixed(0)} s
          </p>
          {r.byStrategy.length > 0 && (
            <ul className="mb-3 divide-y divide-line text-xs">
              {r.byStrategy.map((s) => (
                <li key={s.strategy} className="flex justify-between gap-2 py-1">
                  <span className="truncate text-ink">{strat(s.strategy)}</span>
                  <span className="shrink-0 tabular-nums text-ink-2">
                    {s.n} trades · {s.winRatePct}% wins · <span className={tone(s.totalSol)}>{sol(s.totalSol)}</span> · avg {pct(s.avgPct)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {r.byExit.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-xs font-medium text-ink">By exit</div>
              <ul className="divide-y divide-line text-xs">
                {r.byExit.map((e) => (
                  <li key={e.reason} className="flex justify-between gap-2 py-1">
                    <span className="truncate text-ink-2">{e.reason}</span>
                    <span className={`shrink-0 tabular-nums ${tone(e.totalSol)}`}>
                      {e.n} · {sol(e.totalSol)} · avg {pct(e.avgPct)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.skips.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-xs font-medium text-ink">Why it did not buy (top reasons)</div>
              <ul className="text-xs text-muted">
                {r.skips.map((s) => (
                  <li key={s.reason} className="truncate">
                    ×{s.count.toLocaleString()} {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(r.worst.length > 0 || r.best.length > 0) && (
            <div className="mb-3 grid gap-3 text-xs sm:grid-cols-2">
              {[{ label: 'Best', xs: r.best }, { label: 'Worst', xs: r.worst }].map((g) => (
                <div key={g.label}>
                  <div className="mb-1 font-medium text-ink">{g.label}</div>
                  <ul className="divide-y divide-line">
                    {g.xs.map((t, i) => (
                      <li key={`${t.symbol}-${i}`} className="flex justify-between gap-2 py-1">
                        <span className="truncate text-ink-2">
                          {t.symbol || '?'} · {strat(t.strategy)} · {t.reason}
                        </span>
                        <span className={`shrink-0 tabular-nums ${tone(t.pnlSol)}`}>
                          {pct(t.pnlPct)} · peak {t.peakX}x
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">{r.note}</p>
        </>
      ) : (
        !data?.running && <p className="text-sm text-muted">No replay yet. Recording starts with this update — give it a few hours of tape, then press Run.</p>
      )}
      {!!data?.history?.length && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-ink">Recent runs</div>
          <ul className="divide-y divide-line text-xs">
            {data.history.map((h) => (
              <li key={h.id} className="flex justify-between gap-2 py-1">
                <span className="truncate text-ink-2">
                  {new Date(h.at).toLocaleString()} · {h.policy} · {new Date(h.from).toLocaleDateString()}→{new Date(h.to).toLocaleDateString()}
                </span>
                <span className={`shrink-0 tabular-nums ${tone(h.totalSol)}`}>
                  {h.trades} trades · {h.winRatePct}% · {sol(h.totalSol)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
