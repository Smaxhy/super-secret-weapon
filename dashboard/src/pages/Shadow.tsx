/**
 * Shadow trades: pretend trades on coins the bot did NOT buy (no money), followed with its own exits.
 * Shows what skipping cost: per filter, per refusal reason, and the winners it missed.
 */
import { useState } from 'react';
import { Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { ago, STRATEGY_LABEL } from '../lib/format';

type Kind = 'refused' | 'near' | 'skipped';
interface Group { key: string; example: string; n: number; avgPct: number; winRatePct: number; went2xPct: number; best: Array<{ symbol: string; peakX: number; pnlPct: number }> }
interface Row { mint: string; symbol: string; strategy: string; kind: Kind; why: string; score: number; bar: number; mcUsd: number | null; openedAtMs: number; closedAtMs: number; pnlPct: number; peakX: number; holdSec: number; exitReason: string }
interface Report { total: number; open: number; byKind: Record<Kind, Group>; byStrategy: Group[]; byRule: Group[]; byRefusal: Group[]; findings: string[]; missed: Row[]; recent: Row[] }

const KIND: Record<Kind, { label: string; sub: string }> = {
  refused: { label: 'Wanted, but no room', sub: 'buy signals the trader turned down' },
  near: { label: 'Just under the bar', sub: 'every rule passed, score a bit short' },
  skipped: { label: 'Skipped by a rule', sub: 'a filter said no, score was close' },
};
const pct = (n: number) => `${n > 0 ? '+' : ''}${n}%`;
const tone = (n: number) => (n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-ink-2');
const strat = (s: string) => STRATEGY_LABEL[s] ?? s;

export function Shadow() {
  const { data, error } = useApi<Report | null>('/api/shadow', 60_000);
  const [tab, setTab] = useState<'filters' | 'missed' | 'recent'>('filters');
  return (
    <>
      <PageHeader title="Shadow trades" subtitle="Pretend trades on coins the bot didn't buy — no money, same exits and fees. They show what skipping cost and help the bot learn faster." />
      {error && <ErrorBox message={error} />}
      {!data && !error && <Loading />}
      {data && !data.total && (
        <Empty>
          No shadow trades closed yet{data.open ? ` — ${data.open} are running right now` : ''}. They fill in as the bot checks coins.
        </Empty>
      )}
      {data && data.total > 0 && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(KIND) as Kind[]).map((k) => {
              const g = data.byKind[k];
              return (
                <Card key={k}>
                  <div className="text-sm font-medium text-ink">{KIND[k].label}</div>
                  <div className="text-xs text-muted">{KIND[k].sub}</div>
                  <div className={`mt-2 text-2xl font-semibold tabular-nums ${g.n ? tone(g.avgPct) : 'text-muted'}`}>{g.n ? pct(g.avgPct) : '—'}</div>
                  <div className="text-xs text-muted tabular-nums">{g.n} trades · {g.winRatePct}% wins · {g.went2xPct}% went 2x+</div>
                </Card>
              );
            })}
          </div>
          {data.findings.length > 0 && (
            <Card title="What it found">
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
                {data.findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </Card>
          )}
          <div className="flex gap-1 rounded-xl border border-line bg-surface p-1 text-sm" role="tablist">
            {([['filters', 'What the filters cost'], ['missed', 'Missed winners'], ['recent', 'Latest']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`flex-1 rounded-lg px-2 py-2 font-medium ${tab === id ? 'bg-accent/12 text-accent' : 'text-ink-2 hover:bg-surface-2'}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'filters' && (
            <>
              <Card title="Skipped by a rule">
                <GroupTable rows={data.byRule} label="Rule" empty="No skipped coins closed yet." />
              </Card>
              <Card title="Wanted, but refused">
                <GroupTable rows={data.byRefusal} label="Why it was refused" empty="No refused buy signals yet." />
              </Card>
            </>
          )}
          {tab === 'missed' && (
            <Card title="Coins it didn't buy that went 2x or more">
              <RowList rows={data.missed} empty="None yet." />
            </Card>
          )}
          {tab === 'recent' && (
            <Card title={`Latest shadow trades · ${data.open} still running`}>
              <RowList rows={data.recent} empty="None yet." />
            </Card>
          )}
          <p className="text-xs text-muted">Counted toward learning: "wanted" and "just under the bar" trades, at half the weight of a real trade. "Skipped by a rule" trades only measure what each filter costs or saves.</p>
        </div>
      )}
    </>
  );
}

function GroupTable({ rows, label, empty }: { rows: Group[]; label: string; empty: string }) {
  if (!rows.length) return <p className="text-sm text-ink-2">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 font-normal">{label}</th>
            <th className="py-1 text-right font-normal">Coins</th>
            <th className="py-1 text-right font-normal">If bought</th>
            <th className="py-1 text-right font-normal">Wins</th>
            <th className="py-1 text-right font-normal">2x+</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key} className="border-t border-line align-top">
              <td className="py-1.5 pr-2 text-ink">
                <div className="break-words">{g.example}</div>
                {g.best.length > 0 && g.best[0]!.peakX >= 1.5 && <div className="text-xs text-muted">best: {g.best.map((b) => `${b.symbol} ${b.peakX}x`).join(', ')}</div>}
              </td>
              <td className="py-1.5 text-right tabular-nums text-ink-2">{g.n}</td>
              <td className={`py-1.5 text-right tabular-nums ${tone(g.avgPct)}`}>{pct(g.avgPct)}</td>
              <td className="py-1.5 text-right tabular-nums text-ink-2">{g.winRatePct}%</td>
              <td className="py-1.5 text-right tabular-nums text-ink-2">{g.went2xPct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowList({ rows, empty }: { rows: Row[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-ink-2">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={`${r.mint}-${r.openedAtMs}`} className="flex items-start justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink">
              {r.symbol} <span className="text-xs font-normal text-muted">{strat(r.strategy)} · {KIND[r.kind].label.toLowerCase()}</span>
            </div>
            <div className="break-words text-xs text-muted">{r.why} · score {r.score.toFixed(0)} / bar {r.bar.toFixed(0)} · {ago(new Date(r.closedAtMs).toISOString())}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`font-semibold tabular-nums ${tone(r.pnlPct)}`}>{pct(r.pnlPct)}</div>
            <div className="text-xs text-muted tabular-nums">peak {r.peakX}x</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
