/** Performance page: the AI coach — what it noticed, and the rules it is testing / using. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, STRATEGY_LABEL } from '../lib/format';
import { Badge, Button, Card, Empty, SectionHeader, StatTile } from './ui';

interface Stats { n: number; avgPct: number; restAvgPct: number }
interface Rule {
  id: string; title: string; why: string; strategy: string | null; action: 'avoid' | 'prefer';
  conditions: Array<{ feature: string; op: 'lt' | 'gt'; value: number }>;
  createdAt: string; status: 'testing' | 'live' | 'retired'; statusWhy: string; backtest: Stats | null; forward: Stats | null;
}
interface Data {
  enabled: boolean; hasKey: boolean; model: string; deepModel?: string; spentTodayUsd: number; budgetUsd: number;
  lastRun: { at: string; trades: number; costUsd: number; model?: string; deep?: boolean } | null; lastError: string | null;
  insights: Array<{ at: string; text: string }>; rules: Rule[];
}


export function AiCoach() {
  const { data, reload } = useApi<Data | null>('/api/ai-coach', 60_000);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (deep = false) => {
    setBusy(true);
    try {
      const r = await api<{ ran: boolean; why: string }>('/api/ai-coach/run', { method: 'POST', body: JSON.stringify({ deep }) });
      setNote(r.why);
      await reload();
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Empty>Loading the AI coach…</Empty>;
  const shown = data.rules.filter((r) => r.status !== 'retired').concat(data.rules.filter((r) => r.status === 'retired').slice(0, 5));
  const counts = { live: data.rules.filter((r) => r.status === 'live').length, testing: data.rules.filter((r) => r.status === 'testing').length };
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="AI coach"
        description="Reads the closed trades, writes down what it notices and proposes rules that are tested before they're used."
        action={
          data.hasKey ? (
            <span className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>{busy ? 'Reading…' : 'Review now'}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(true)}>Deep review</Button>
            </span>
          ) : undefined
        }
      />
      {!data.hasKey ? (
        <Empty>Add ANTHROPIC_API_KEY to /root/bot/.env on the server and restart the bot to turn it on.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile compact label="Spent today" value={`$${data.spentTodayUsd.toFixed(2)}`} sub={`of $${data.budgetUsd.toFixed(2)} budget`} tone={data.spentTodayUsd >= data.budgetUsd ? 'warn' : undefined} />
            <StatTile compact label="Last review" value={data.lastRun ? ago(data.lastRun.at).replace(' ago', '') : '—'} sub={data.lastRun ? `${data.lastRun.trades} trades · $${data.lastRun.costUsd}${data.lastRun.deep ? ' · deep' : ''}` : 'first one soon after start'} />
            <StatTile compact label="Rules live" value={counts.live} sub="proven and in use" tone={counts.live ? 'up' : undefined} />
            <StatTile compact label="Rules testing" value={counts.testing} sub="waiting for new trades" />
          </div>
          {(data.lastError || note) && <p className={`text-sm ${data.lastError ? 'text-down' : 'text-ink-2'}`}>{data.lastError ?? note}</p>}
          <div className="grid gap-6 xl:grid-cols-12">
            <Card title="What it noticed" subtitle={`hourly ${data.model}${data.deepModel ? ` · daily deep ${data.deepModel}` : ''}`} className="xl:col-span-5">
              {data.insights.length ? (
                <ul className="space-y-2 text-sm">
                  {data.insights.slice(0, 10).map((i) => (
                    <li key={i.at + i.text} className="rounded-xl bg-surface-2/60 px-3 py-2.5 leading-relaxed text-ink">
                      {i.text}
                      <div className="mt-1 text-xs text-muted">{ago(i.at)}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Nothing yet.</p>
              )}
            </Card>
            <Card title="Rules" subtitle="Tested on new trades first. Live = proven and in use; retired = didn't hold up." className="xl:col-span-7">
              {shown.length === 0 ? (
                <p className="text-sm text-muted">No rules yet.</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {shown.map((r) => (
                    <li key={r.id} className={`py-3 first:pt-0 last:pb-0 ${r.status === 'retired' ? 'opacity-60' : ''}`}>
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <span className="min-w-0 text-ink">
                          <span className={`font-medium ${r.action === 'avoid' ? 'text-down' : 'text-up'}`}>{r.action === 'avoid' ? 'Avoid' : 'Prefer'}</span> · {r.title}
                        </span>
                        <Badge tone={r.status === 'live' ? 'up' : r.status === 'testing' ? 'accent' : 'neutral'}>{r.status}</Badge>
                      </div>
                      <div className="mt-1 break-words font-mono text-xs text-ink-2">{r.conditions.map((c) => `${c.feature} ${c.op === 'lt' ? '<' : '>'} ${c.value}`).join(' and ')}</div>
                      <div className="mt-0.5 text-xs text-muted">{r.strategy ? STRATEGY_LABEL[r.strategy] ?? r.strategy : 'All strategies'} · {r.statusWhy}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
