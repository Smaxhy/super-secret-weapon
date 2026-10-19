/** Brain page: the self-improving loop — one change a day, proven on the recorded market, watched live, undone if it fails. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Button, Card, Loading, Row, Rows } from './ui';

interface Summary { trades: number; totalSol: number; avgPct: number; profitFactor: number | null; winRatePct: number }
interface Experiment {
  id: string;
  key: string;
  label: string;
  from: number | boolean | null;
  to: number | boolean;
  why: string;
  source: 'ai' | 'rules' | 'tournament';
  proposedAt: number;
  status: 'proving' | 'rejected' | 'watching' | 'kept' | 'reverted';
  statusWhy: string;
  appliedAt?: number;
  finishedAt?: number;
  replay?: { base: Summary; cand: Summary };
  live?: { n: number; avgPct: number | null; preAvgPct: number | null };
}
interface LoopData { enabled: boolean; current?: Experiment | null; history?: Experiment[]; lastResult?: { at: number; text: string } | null }

const TONE: Record<Experiment['status'], 'accent' | 'up' | 'down' | 'warn' | 'neutral'> = { proving: 'accent', watching: 'warn', kept: 'up', reverted: 'down', rejected: 'neutral' };
const NAME: Record<Experiment['status'], string> = { proving: 'Testing on the tape', watching: 'Live — watching', kept: 'Kept', reverted: 'Undone', rejected: 'Not proven' };
const v = (x: number | boolean | null | undefined) => (typeof x === 'boolean' ? (x ? 'on' : 'off') : x ?? '—');
const sol = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)} SOL`;
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x}%`);
const line = (s: Summary) => `${s.trades} trades · ${sol(s.totalSol)} · ${pct(s.avgPct)}/trade`;

export function LoopCard() {
  const { data, error, reload } = useApi<LoopData>('/api/loop', 60_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ran: boolean; why: string }>('/api/loop/run', { method: 'POST' });
      setMsg(r.why);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cur = data?.current ?? null;
  return (
    <Card
      title="Self-improving loop"
      subtitle="Once a day it tries one change, proves it on the recorded market, keeps it only if live trades agree."
      action={
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy || !data?.enabled}>
          {busy ? 'Starting…' : 'Run now'}
        </Button>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <Loading kind="rows" />}
      {data && !data.enabled && <p className="text-sm text-ink-2">The loop isn't running on this bot.</p>}
      {msg && <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">{msg}</p>}
      {data?.enabled && (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-2 text-xs font-semibold text-muted">Now</div>
            {cur ? (
              <div className="rounded-xl border border-line p-3">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0 font-medium text-ink">{cur.label}</div>
                  <Badge tone={TONE[cur.status]}>{NAME[cur.status]}</Badge>
                </div>
                <div className="mt-1 tabular-nums text-ink">
                  {v(cur.from)} → <span className="font-semibold">{v(cur.to)}</span>
                  <span className="ml-2 text-xs text-muted">{cur.source === 'ai' ? 'AI idea' : cur.source === 'tournament' ? 'tournament winner' : 'from Bot health'}</span>
                </div>
                <p className="mt-1 text-sm text-ink-2">{cur.why}</p>
                <Rows className="mt-2">
                  {cur.replay && <Row label="Replay, today's rules" value={line(cur.replay.base)} />}
                  {cur.replay && <Row label="Replay, with the change" value={line(cur.replay.cand)} tone={cur.replay.cand.totalSol >= cur.replay.base.totalSol ? 'up' : 'down'} />}
                  {cur.live && <Row label="Live since applied" value={`${cur.live.n} trades · ${pct(cur.live.avgPct)}/trade`} sub={cur.live.preAvgPct !== null ? `before: ${pct(cur.live.preAvgPct)}/trade` : undefined} />}
                </Rows>
                <p className="mt-2 text-xs text-muted">{cur.statusWhy}</p>
              </div>
            ) : (
              <p className="text-sm text-ink-2">{data.lastResult ? `${data.lastResult.text} (${ago(new Date(data.lastResult.at).toISOString())})` : 'Nothing running. The next try is at 05:00 UTC, or press Run now.'}</p>
            )}
          </div>
          <div className="min-w-0">
            <div className="mb-2 text-xs font-semibold text-muted">Past experiments</div>
            {!data.history?.length ? (
              <p className="text-sm text-ink-2">None yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.history.slice(0, 10).map((e) => (
                  <li key={e.id} className="py-2">
                    <div className="flex min-w-0 items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-ink" title={e.label}>
                        {e.label} <span className="tabular-nums text-ink-2">{v(e.from)} → {v(e.to)}</span>
                      </span>
                      <Badge tone={TONE[e.status]}>{NAME[e.status]}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {e.finishedAt ? ago(new Date(e.finishedAt).toISOString()) : ''} · {e.statusWhy}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
