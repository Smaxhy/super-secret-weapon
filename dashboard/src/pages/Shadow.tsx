/**
 * Shadow trades: pretend trades on coins the bot did NOT buy (no money), followed with its own exits.
 * Shows what skipping cost: per filter, per refusal reason, and the winners it missed.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Chip, Empty, ErrorBox, Loading, PageHeader, StatTile, Table, Tabs, Th, tdCls, theadCls, trCls, useStored } from '../components/ui';
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
  const [view, setView] = useStored<'filters' | 'missed' | 'recent'>('shadow.view', 'filters', ['filters', 'missed', 'recent']);
  const [kind, setKind] = useState<'all' | Kind>('all');
  const rows = (view === 'missed' ? data?.missed : data?.recent) ?? [];
  const shown = kind === 'all' ? rows : rows.filter((r) => r.kind === kind);
  return (
    <>
      <PageHeader title="Shadow trades" subtitle="Pretend trades on coins it didn't buy (same exits and fees, no money): what skipping cost." />
      {error && <ErrorBox message={error} />}
      {!data && !error && <Loading />}
      {data && !data.total && <Empty>No shadow trades closed yet{data.open ? `; ${data.open} are running right now` : ''}. They fill in as the bot checks coins.</Empty>}
      {data && data.total > 0 && (
        <div className="flex flex-col gap-6">
          <section aria-label="If it had bought them" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile compact label="Shadow trades" value={data.total.toLocaleString()} sub={`${data.open} still running`} />
            {(Object.keys(KIND) as Kind[]).map((k) => {
              const g = data.byKind[k];
              return <StatTile key={k} compact label={KIND[k].label} value={g.n ? <span className={tone(g.avgPct)}>{pct(g.avgPct)}</span> : '—'} sub={`${g.n} · ${g.winRatePct}% wins · ${g.went2xPct}% 2x+`} />;
            })}
          </section>

          <div className="grid gap-6 xl:grid-cols-12">
            <div className="flex min-w-0 flex-col gap-4 xl:col-span-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Tabs className="w-full sm:w-[24rem]" label="Shadow trade views" value={view} onChange={setView} tabs={[{ key: 'filters', label: 'Filter cost' }, { key: 'missed', label: 'Missed winners' }, { key: 'recent', label: 'Latest' }]} />
                {view !== 'filters' && (
                  <div className="no-scrollbar flex gap-1.5 overflow-x-auto" role="group" aria-label="Kind">
                    <Chip active={kind === 'all'} onClick={() => setKind('all')} count={rows.length}>All</Chip>
                    {(Object.keys(KIND) as Kind[]).map((k) => (
                      <Chip key={k} active={kind === k} onClick={() => setKind(k)} count={rows.filter((r) => r.kind === k).length}>{KIND_SHORT[k]}</Chip>
                    ))}
                  </div>
                )}
              </div>
              {view === 'filters' ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  <Card title="Skipped by a rule" subtitle="What each filter cost or saved">
                    <GroupTable rows={data.byRule} label="Rule" empty="No skipped coins closed yet." />
                  </Card>
                  <Card title="Wanted, but refused" subtitle="Buy signals the trader said no to">
                    <GroupTable rows={data.byRefusal} label="Why it was refused" empty="No refused buy signals yet." />
                  </Card>
                </div>
              ) : (
                <RowTable rows={shown} empty={view === 'missed' ? 'No missed 2x coins yet.' : 'None yet.'} />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-6 xl:col-span-4">
              {data.findings.length > 0 && (
                <Card title="What it found">
                  <ul className="space-y-2 text-sm">
                    {data.findings.map((f) => (
                      <li key={f} className="rounded-xl bg-surface-2/60 px-3 py-2.5 leading-relaxed text-ink">{f}</li>
                    ))}
                  </ul>
                </Card>
              )}
              <Card title="By strategy">
                <GroupTable rows={data.byStrategy.map((g) => ({ ...g, example: strat(g.key) }))} label="Strategy" empty="Nothing yet." />
              </Card>
              <p className="text-xs text-muted">Counted toward learning: "wanted" and "just under the bar" trades, at half the weight of a real trade. "Skipped by a rule" trades only measure what each filter costs or saves.</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const KIND_SHORT: Record<Kind, string> = { refused: 'Wanted', near: 'Under the bar', skipped: 'Skipped' };

function GroupTable({ rows, label, empty }: { rows: Group[]; label: string; empty: string }) {
  if (!rows.length) return <p className="text-sm text-ink-2">{empty}</p>;
  return (
    <ul className="-my-1 divide-y divide-line">
      {rows.map((g) => (
        <li key={g.key} className="flex items-start justify-between gap-3 py-2.5 text-sm">
          <div className="min-w-0">
            <div className="break-words text-ink">{g.example}</div>
            {g.best.length > 0 && g.best[0]!.peakX >= 1.5 && <div className="text-xs text-muted">best: {g.best.map((b) => `${b.symbol} ${b.peakX}x`).join(', ')}</div>}
          </div>
          <div className="shrink-0 text-right">
            <div className={`font-semibold tabular-nums ${tone(g.avgPct)}`}>{pct(g.avgPct)}</div>
            <div className="text-xs text-muted tabular-nums">
              {g.n} {label === 'Rule' ? 'coins' : label === 'Strategy' ? 'trades' : 'signals'} · {g.winRatePct}% wins
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RowTable({ rows, empty }: { rows: Row[]; empty: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <>
      <ul className="card divide-y divide-line overflow-hidden md:hidden">
        {rows.map((r) => (
          <li key={`${r.mint}-${r.openedAtMs}`} className="flex items-start justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link to={`/token/${r.mint}`} className="truncate font-semibold text-ink">{r.symbol}</Link>
                <Badge tone={r.kind === 'refused' ? 'accent' : r.kind === 'near' ? 'warn' : 'neutral'}>{KIND_SHORT[r.kind]}</Badge>
              </div>
              <div className="line-clamp-2 text-xs text-muted" title={r.why}>{strat(r.strategy)} · {r.why}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className={`font-semibold tabular-nums ${tone(r.pnlPct)}`}>{pct(r.pnlPct)}</div>
              <div className="text-xs text-muted tabular-nums">peak {r.peakX}x</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table minWidth={760}>
          <thead className={theadCls}>
            <tr>
              <Th>Coin</Th>
              <Th>Kind</Th>
              <Th>Why it didn't buy</Th>
              <Th right>Score / bar</Th>
              <Th right>Result</Th>
              <Th right>Peak</Th>
              <Th right>Closed</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.mint}-${r.openedAtMs}`} className={trCls}>
                <td className={tdCls}>
                  <Link to={`/token/${r.mint}`} className="font-semibold text-ink hover:underline">{r.symbol}</Link>
                  <div className="text-xs text-muted">{strat(r.strategy)}</div>
                </td>
                <td className={tdCls}><Badge tone={r.kind === 'refused' ? 'accent' : r.kind === 'near' ? 'warn' : 'neutral'}>{KIND_SHORT[r.kind]}</Badge></td>
                <td className={`${tdCls} max-w-[22rem] text-ink-2`}><span className="line-clamp-2" title={r.why}>{r.why}</span></td>
                <td className={`${tdCls} text-right text-ink-2`}>{r.score.toFixed(0)} / {r.bar.toFixed(0)}</td>
                <td className={`${tdCls} text-right font-semibold ${tone(r.pnlPct)}`}>{pct(r.pnlPct)}</td>
                <td className={`${tdCls} text-right text-ink-2`}>{r.peakX}x</td>
                <td className={`${tdCls} text-right text-muted`}>{ago(new Date(r.closedAtMs).toISOString())}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
