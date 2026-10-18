/**
 * Performance → Tests: "Replay" — the bot's rules run over the recorded market (TradeTape) in a child process on
 * the VPS. POST /api/replay starts one, GET /api/replay has the running job, the last report and recent runs.
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { SignedBars } from './Charts';
import { Badge, Button, Card, Empty, inputCls, RankedBars, Row, Rows, SectionHeader } from './ui';

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
  const [picked, setPicked] = useState<string[]>([]);
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
  const history = data?.history ?? [];
  const pickedRuns = history.filter((h) => picked.includes(h.id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Replay the rules over the recorded market" description="Every trade on every coin is recorded. A replay runs the entry rules and exits over those days in minutes: a number instead of a week of waiting." />
      <div className="grid gap-6 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-4">
          <Card title="Run a replay">
            <div className="flex flex-col gap-3">
              <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
                From
                <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
                To
                <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
              </label>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-xs font-medium text-muted">Rules</legend>
                {([['live', 'Live rules', 'as the bot trades now'], ['sniper', 'Sniper', 'fewer, bigger trades']] as const).map(([k, l, sub]) => (
                  <label key={k} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${policy === k ? 'border-accent bg-accent/8' : 'border-line hover:bg-surface-2'}`}>
                    <input type="radio" name="replay-policy" value={k} checked={policy === k} onChange={() => setPolicy(k)} className="accent-[var(--accent)]" />
                    <span>
                      <span className="block font-medium text-ink">{l}</span>
                      <span className="block text-xs text-muted">{sub}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <Button disabled={busy || running} onClick={() => void run()} className="w-full">
                <Icon name="play" size={15} />
                {running ? 'Running…' : 'Run replay'}
              </Button>
              {(error || err) && <p className="text-sm text-down">{error ?? err}</p>}
              {data?.running && (
                <div className="fade-in rounded-xl border border-line bg-surface-2/50 p-3 text-xs text-muted">
                  <div className="mb-1 flex items-center gap-2 font-medium text-ink">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                    Replaying since {new Date(data.running.startedAt).toLocaleTimeString()}…
                  </div>
                  {data.running.log.slice(-3).map((l, i) => (
                    <div key={i} className="truncate" title={l}>{l}</div>
                  ))}
                </div>
              )}
              {data?.lastJob && data.lastJob.exitCode !== 0 && data.lastJob.exitCode !== null && !data.running && (
                <p className="text-sm text-down">The last replay failed: {data.lastJob.log.slice(-2).join(' · ') || `exit code ${data.lastJob.exitCode}`}</p>
              )}
            </div>
          </Card>
          {history.length > 0 && (
            <Card title="Recent runs" subtitle="Tick two to compare them side by side.">
              <ul className="divide-y divide-line">
                {history.map((h) => (
                  <li key={h.id}>
                    <label className="flex min-h-12 cursor-pointer items-center gap-3 py-2 text-sm">
                      <input type="checkbox" checked={picked.includes(h.id)} onChange={() => toggle(h.id)} className="h-4 w-4 accent-[var(--accent)]" aria-label={`Compare run of ${new Date(h.at).toLocaleString()}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ink">{h.policy} · {new Date(h.from).toLocaleDateString()} → {new Date(h.to).toLocaleDateString()}</span>
                        <span className="block text-xs text-muted">{h.trades} trades · {h.winRatePct}% wins · {new Date(h.at).toLocaleString()}</span>
                      </span>
                      <span className={`tabular shrink-0 font-medium ${tone(h.totalSol)}`}>{sol(h.totalSol)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6 xl:col-span-8">
          {pickedRuns.length === 2 && <Compare a={pickedRuns[0]!} b={pickedRuns[1]!} onClear={() => setPicked([])} />}
          {r ? (
            <>
              <Card>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge tone="accent">{r.policy} rules</Badge>
                  <span>{new Date(r.from).toLocaleString()} → {new Date(r.to).toLocaleString()}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={`tabular text-3xl font-bold tracking-tight ${tone(r.totalSol)}`}>{sol(r.totalSol)}</span>
                  <span className="text-sm text-ink-2">on {r.trades} trades · {r.winRatePct}% wins · {r.sizeSol} SOL each</span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Mini label="Avg per trade" value={<span className={tone(r.avgPct)}>{pct(r.avgPct)}</span>} />
                  <Mini label="Median" value={<span className={tone(r.medianPct)}>{pct(r.medianPct)}</span>} />
                  <Mini label="Profit factor" value={r.profitFactor !== null ? r.profitFactor.toFixed(2) : '—'} />
                  <Mini label="Buy signals" value={r.signals.toLocaleString()} />
                </dl>
                <p className="mt-3 text-xs text-muted">
                  {r.rows.toLocaleString()} recorded trades on {r.coins.toLocaleString()} coins · {r.evaluated.toLocaleString()} checks · took {(r.durationMs / 1000).toFixed(0)} s
                </p>
              </Card>
              <div className="grid gap-6 lg:grid-cols-2">
                {r.byStrategy.length > 0 && (
                  <Card title="By strategy">
                    <SignedBars data={r.byStrategy.map((s) => ({ name: strat(s.strategy), totalSol: s.totalSol, trades: s.n }))} labelKey="name" valueKey="totalSol" height={160} />
                    <Rows className="mt-3">
                      {r.byStrategy.map((s) => (
                        <Row key={s.strategy} label={strat(s.strategy)} sub={`${s.n} trades · ${s.winRatePct}% wins · avg ${pct(s.avgPct)}`} value={<span className={tone(s.totalSol)}>{sol(s.totalSol)}</span>} />
                      ))}
                    </Rows>
                  </Card>
                )}
                {r.byExit.length > 0 && (
                  <Card title="By exit">
                    <SignedBars data={r.byExit.map((e) => ({ name: e.reason, totalSol: e.totalSol, trades: e.n }))} labelKey="name" valueKey="totalSol" height={160} />
                    <Rows className="mt-3">
                      {r.byExit.map((e) => (
                        <Row key={e.reason} label={e.reason} sub={`${e.n} · avg ${pct(e.avgPct)}`} value={<span className={tone(e.totalSol)}>{sol(e.totalSol)}</span>} />
                      ))}
                    </Rows>
                  </Card>
                )}
              </div>
              {r.skips.length > 0 && (
                <Card title="Why it did not buy" subtitle="Top reasons a coin was passed over in the replay">
                  <RankedBars rows={r.skips.map((s) => ({ label: s.reason, count: s.count }))} />
                </Card>
              )}
              {(r.worst.length > 0 || r.best.length > 0) && (
                <div className="grid gap-6 sm:grid-cols-2">
                  {[{ label: 'Best trades', xs: r.best }, { label: 'Worst trades', xs: r.worst }].map((g) => (
                    <Card key={g.label} title={g.label}>
                      <Rows>
                        {g.xs.map((t, i) => (
                          <Row key={`${t.symbol}-${i}`} label={t.symbol || '?'} sub={`${strat(t.strategy)} · ${t.reason} · peak ${t.peakX}×`} value={<span className={tone(t.pnlSol)}>{pct(t.pnlPct)}</span>} />
                        ))}
                      </Rows>
                    </Card>
                  ))}
                </div>
              )}
              <p className="text-xs leading-relaxed text-muted">{r.note}</p>
            </>
          ) : (
            !data?.running && <Empty>No replay yet. Give the recorder a few hours of tape, then press Run.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}

type Run = Status['history'][number];
/** Two recent runs side by side with the difference (second minus first). */
function Compare({ a, b, onClear }: { a: Run; b: Run; onClear: () => void }) {
  const rows: Array<[string, (r: Run) => number, (x: number) => string]> = [
    ['Net', (r) => r.totalSol, (x) => sol(x)],
    ['Trades', (r) => r.trades, (x) => `${x >= 0 && x !== 0 ? '+' : ''}${x}`],
    ['Win rate', (r) => r.winRatePct, (x) => `${x.toFixed(0)}%`],
    ['Avg per trade', (r) => r.avgPct, (x) => pct(x)],
  ];
  const label = (r: Run) => `${r.policy} · ${new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  return (
    <Card title="Compare runs" action={<Button variant="ghost" size="sm" onClick={onClear}>Clear</Button>}>
      <div className="overflow-x-auto">
        <table className="tabular w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2 font-medium" />
              <th className="py-2 text-right font-medium">{label(a)}</th>
              <th className="py-2 text-right font-medium">{label(b)}</th>
              <th className="py-2 text-right font-medium">Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, get, fmt]) => {
              const diff = get(b) - get(a);
              return (
                <tr key={name} className="border-t border-line">
                  <td className="py-2 text-ink-2">{name}</td>
                  <td className="py-2 text-right text-ink">{name === 'Trades' ? get(a) : fmt(get(a))}</td>
                  <td className="py-2 text-right text-ink">{name === 'Trades' ? get(b) : fmt(get(b))}</td>
                  <td className={`py-2 text-right font-medium ${tone(diff)}`}>{name === 'Win rate' ? `${diff >= 0 ? '+' : ''}${diff.toFixed(0)} pts` : fmt(diff)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
