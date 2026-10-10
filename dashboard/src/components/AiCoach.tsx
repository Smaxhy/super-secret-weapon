/** Performance page: the AI coach — what it noticed, and the rules it is testing / using. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, STRATEGY_LABEL } from '../lib/format';
import { Card } from './ui';

interface Stats { n: number; avgPct: number; restAvgPct: number }
interface Rule {
  id: string; title: string; why: string; strategy: string | null; action: 'avoid' | 'prefer';
  conditions: Array<{ feature: string; op: 'lt' | 'gt'; value: number }>;
  createdAt: string; status: 'testing' | 'live' | 'retired'; statusWhy: string; backtest: Stats | null; forward: Stats | null;
}
interface Data {
  enabled: boolean; hasKey: boolean; model: string; spentTodayUsd: number; budgetUsd: number;
  lastRun: { at: string; trades: number; costUsd: number } | null; lastError: string | null;
  insights: Array<{ at: string; text: string }>; rules: Rule[];
}

const BADGE: Record<Rule['status'], string> = { live: 'border-up/40 text-up', testing: 'border-line text-ink-2', retired: 'border-line text-muted line-through' };

export function AiCoach() {
  const { data, reload } = useApi<Data | null>('/api/ai-coach', 60_000);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ ran: boolean; why: string }>('/api/ai-coach/run', { method: 'POST' });
      setNote(r.why);
      await reload();
    } finally {
      setBusy(false);
    }
  };
  if (!data) return null;
  const shown = data.rules.filter((r) => r.status !== 'retired').concat(data.rules.filter((r) => r.status === 'retired').slice(0, 5));
  return (
    <Card
      title="AI coach"
      className="mb-4"
      action={
        data.hasKey ? (
          <button type="button" disabled={busy} onClick={() => void run()} className="text-sm text-accent hover:underline disabled:opacity-50">
            {busy ? 'Reading trades…' : 'Review now'}
          </button>
        ) : undefined
      }
    >
      {!data.hasKey ? (
        <p className="text-sm text-ink-2">Add ANTHROPIC_API_KEY to /root/bot/.env on the server and restart the bot to turn it on.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted">
            {data.model} · spent today ${data.spentTodayUsd.toFixed(2)} of ${data.budgetUsd.toFixed(2)}
            {data.lastRun ? ` · last review ${ago(data.lastRun.at)} (${data.lastRun.trades} trades, $${data.lastRun.costUsd})` : ' · first review a few minutes after start, then hourly when new trades closed'}
          </p>
          {(data.lastError || note) && <p className={`text-sm ${data.lastError ? 'text-down' : 'text-ink-2'}`}>{data.lastError ?? note}</p>}
          {data.insights.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-ink">What it noticed</div>
              <ul className="list-disc space-y-1 pl-5 text-ink">
                {data.insights.slice(0, 8).map((i) => (
                  <li key={i.at + i.text}>{i.text}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="mb-1 font-medium text-ink">Rules</div>
            <p className="mb-2 text-xs text-muted">Every rule is tested on new trades first. Live = proven and in use; retired = didn't hold up.</p>
            {shown.length === 0 ? (
              <p className="text-xs text-muted">No rules yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {shown.map((r) => (
                  <li key={r.id} className="py-2">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="min-w-0 text-ink">
                        <span className={r.action === 'avoid' ? 'text-down' : 'text-up'}>{r.action === 'avoid' ? 'Avoid' : 'Prefer'}</span> · {r.strategy ? STRATEGY_LABEL[r.strategy] ?? r.strategy : 'all strategies'} — {r.title}
                      </span>
                      <span className={`shrink-0 rounded border px-1.5 text-xs ${BADGE[r.status]}`}>{r.status}</span>
                    </div>
                    <div className="mt-0.5 break-words text-xs text-muted">
                      {r.conditions.map((c) => `${c.feature} ${c.op === 'lt' ? '<' : '>'} ${c.value}`).join(' and ')} · {r.statusWhy}
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
