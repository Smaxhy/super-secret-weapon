/**
 * Brain: what the self-improving learners know — the win-probability model (and whether it has earned a say),
 * rules the statistical search discovered (testing → live), how the budget is shifted between strategies,
 * the learned entry styles and every change the bot made.
 */
import { BrainTips } from '../components/BrainTips';
import { Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { ago, STRATEGY_LABEL } from '../lib/format';

interface Explain { feature: string; effect: number; text: string }
interface Report { n: number; nVal: number; valAuc: number; baselineAuc: number; features: number; reason: string; active: boolean; calibration?: Array<{ pMean: number; winRate: number; n: number }> }
interface Rule { title: string; why: string; evidence?: { n: number; avgPct: number; restAvgPct: number; qValue: number; holdoutAvgPct: number } }
interface Discovered { title: string; status: 'testing' | 'live' | 'retired'; statusWhy: string }
interface Alloc { strategy: string; n: number; effN: number; meanPct: number; lowerPct: number; upperPct: number; multiplier: number; base: number; fraction: number; why: string }
interface Style { strategy: string; minOffHighPct: number; maxRun3mPct: number | null; why: string[] }
interface Change { at: string; source: string; what: string; why: string }
interface BrainData {
  model: { active: boolean; using?: 'both' | 'logistic' | 'trees' | 'none'; trainedAt: string; report: Report | null; explain: Explain[]; tree?: { active: boolean; report: Report & { trees: number }; explain: Explain[] } | null } | null;
  coinsChecked?: { pending: number; stored: number; stats: { recorded: number; labelled: number; dropped: number }; byStrategy: Array<{ strategy: string; n: number; avgPct: number; winRatePct: number; went2xPct: number }>; byScore: Array<{ band: string; n: number; avgPct: number; winRatePct: number }> } | null;
  search: { ranAt: number | string; rows: number; tested: number; found: number; rules: Rule[] } | null;
  discoveredRules: Discovered[];
  allocation: Alloc[] | null;
  entryStyles: Style[];
  changes: Change[];
  exitTimers?: Array<{ strategy: string; timer: string; n: number; ranPct: number; medianEndX: number; avgMaxAfterX: number; action: 'longer' | 'shorter' | 'keep'; why: string }>;
}
const TIMER: Record<string, string> = { timeStop: 'No follow-through', stall: 'Stalled', stale: 'Stale (no movement)', maxHold: 'Max hold' };

const strat = (s: string) => STRATEGY_LABEL[s] ?? s;
const STATUS: Record<Discovered['status'], string> = { testing: 'testing on new trades', live: 'LIVE', retired: 'retired' };
const r2 = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '—');

export function Brain() {
  const { data, error } = useApi<BrainData | null>('/api/brain', 60_000);
  return (
    <>
      <PageHeader title="Brain" subtitle="What the bot has learned on its own, what it's testing, and what it changed. Nothing goes live without proving itself on new trades first." />
      <div className="mb-4">
        <BrainTips />
      </div>
      {error && <ErrorBox message={error} />}
      {!data && !error && <Loading />}
      {data === null && !error && <Empty>The brain starts a few minutes after the bot starts.</Empty>}
      {data && (
        <div className="space-y-4">
          <Card title="Win-probability models">
            {!data.model ? (
              <p className="text-sm text-ink-2">Training soon (first run ~2 min after start, then hourly).</p>
            ) : (
              <div className="space-y-4 text-sm">
                <div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${data.model.active ? 'bg-up/15 text-up' : 'bg-surface-2 text-ink-2'}`}>
                    {data.model.using === 'both' ? 'ON — both models together' : data.model.using === 'trees' ? 'ON — tree model' : data.model.using === 'logistic' ? 'ON — straight-line model' : 'not trusted yet'}
                  </span>
                  <span className="ml-2 text-xs text-muted">trained {ago(data.model.trainedAt)} · they only get a say after beating the score on the newest, unseen trades</span>
                </div>
                {[
                  { title: 'Straight-line model', sub: 'learns "more of this → more wins"', r: data.model.report, ex: data.model.explain, extra: null as string | null },
                  { title: 'Tree model', sub: 'learns combinations ("many buyers only helps when the dev sold")', r: data.model.tree?.report ?? null, ex: data.model.tree?.explain ?? [], extra: data.model.tree ? `${data.model.tree.report.trees} trees` : null },
                ].map((m) => (
                  <div key={m.title} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-ink">{m.title}</span>
                      <span className={`text-xs font-semibold ${m.r?.active ? 'text-up' : 'text-muted'}`}>{m.r ? (m.r.active ? 'passed the exam' : 'not yet') : 'training soon'}</span>
                    </div>
                    <p className="text-xs text-muted">{m.sub}</p>
                    {m.r && (
                      <>
                        <p className="mt-1 text-ink-2">{m.r.reason}</p>
                        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <Stat label="Predicts winners (AUC)" value={r2(m.r.valAuc)} sub="0.5 = coin flip" />
                          <Stat label="Current score (AUC)" value={r2(m.r.baselineAuc)} sub="what it must beat" />
                          <Stat label="Learned from" value={m.r.n.toLocaleString()} sub={`${m.r.nVal.toLocaleString()} kept for the exam`} />
                          <Stat label="Features" value={String(m.r.features)} sub={m.extra ?? undefined} />
                        </div>
                      </>
                    )}
                    {m.ex.length > 0 && (
                      <div className="mt-2">
                        <div className="mb-1 text-xs font-medium text-muted">What it weighs most</div>
                        <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
                          {m.ex.slice(0, 6).map((e) => (
                            <li key={e.feature} className="break-words">{e.text}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Learning from every coin it checks">
            {!data.coinsChecked ? (
              <p className="text-sm text-ink-2">Starting — every coin it looks at and doesn't buy is replayed 45 min later with its own exits.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <p className="text-ink-2">
                  {data.coinsChecked.stored.toLocaleString()} coins learned from · {data.coinsChecked.pending.toLocaleString()} waiting to be scored. Each one is a lesson: "what would buying it right then have made?"
                </p>
                {data.coinsChecked.byScore.some((b) => b.n > 0) && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted">Coins it skipped, by how close they were to the buy bar (last 2 days)</div>
                    <ul className="space-y-1">
                      {data.coinsChecked.byScore.filter((b) => b.n > 0).map((b) => (
                        <li key={b.band} className="flex justify-between gap-2">
                          <span className="text-ink-2">{b.band}</span>
                          <span className={b.avgPct >= 0 ? 'text-up' : 'text-down'}>{b.avgPct > 0 ? '+' : ''}{b.avgPct}% avg · {b.winRatePct}% wins · {b.n}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.coinsChecked.byStrategy.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted">By strategy</div>
                    <ul className="space-y-1">
                      {data.coinsChecked.byStrategy.map((b) => (
                        <li key={b.strategy} className="flex justify-between gap-2">
                          <span className="text-ink-2">{strat(b.strategy)}</span>
                          <span className={b.avgPct >= 0 ? 'text-up' : 'text-down'}>{b.avgPct > 0 ? '+' : ''}{b.avgPct}% avg · {b.went2xPct}% went 2x · {b.n}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card title="Rules it discovered">
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted">
                {data.search ? `Searched ${data.search.rows} trades (${data.search.tested.toLocaleString()} ideas tested, false alarms filtered out) · ${data.search.found} found in the last run` : 'First search runs ~6 min after start, then hourly.'}
              </p>
              {data.discoveredRules.length === 0 ? (
                <p className="text-ink-2">Nothing has passed the checks yet — it only keeps patterns that hold on newer trades too.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.discoveredRules.map((r) => (
                    <li key={r.title} className="py-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words font-medium text-ink">{r.title}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${r.status === 'live' ? 'bg-up/15 text-up' : r.status === 'retired' ? 'bg-surface-2 text-muted' : 'bg-accent/12 text-accent'}`}>{STATUS[r.status]}</span>
                      </div>
                      <div className="break-words text-xs text-muted">{r.statusWhy}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card title="Budget per strategy">
            {!data.allocation?.length ? (
              <p className="text-sm text-ink-2">Every strategy on its normal budget until there's enough evidence (~10 trades each).</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <thead className="text-xs text-muted">
                    <tr>
                      <th className="py-1 font-normal">Strategy</th>
                      <th className="py-1 text-right font-normal">Trades</th>
                      <th className="py-1 text-right font-normal">Likely per trade</th>
                      <th className="py-1 text-right font-normal">Budget</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.allocation.map((a) => (
                      <tr key={a.strategy} className="border-t border-line align-top">
                        <td className="py-1.5 pr-2 text-ink">
                          {strat(a.strategy)}
                          <div className="text-xs text-muted">{a.why}</div>
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-ink-2">{a.n}</td>
                        <td className={`py-1.5 text-right tabular-nums ${a.meanPct >= 0 ? 'text-up' : 'text-down'}`}>
                          {a.meanPct >= 0 ? '+' : ''}
                          {a.meanPct.toFixed(1)}%
                        </td>
                        <td className={`py-1.5 text-right tabular-nums font-medium ${a.multiplier > 1.05 ? 'text-up' : a.multiplier < 0.95 ? 'text-down' : 'text-ink-2'}`}>×{a.multiplier.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {data.entryStyles.length > 0 && (
            <Card title="How it enters now (learned)">
              <ul className="space-y-1.5 text-sm text-ink-2">
                {data.entryStyles.map((s) => (
                  <li key={s.strategy}>
                    <span className="font-medium text-ink">{strat(s.strategy)}:</span> {[s.minOffHighPct ? `waits until ${s.minOffHighPct}%+ under the 10-min high` : '', s.maxRun3mPct !== null ? `no chasing above +${s.maxRun3mPct}% in 3 min` : ''].filter(Boolean).join(' · ')}
                    <div className="text-xs text-muted">{s.why.join(' · ')}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Exit timers — what coins did after it sold">
            {!data.exitTimers?.length ? (
              <p className="text-sm text-ink-2">Collecting: every time-based exit is followed for 30 minutes after the sell.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.exitTimers.map((v) => (
                  <li key={`${v.strategy}:${v.timer}`} className="rounded-xl border border-line px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{strat(v.strategy)} · {TIMER[v.timer] ?? v.timer}</span>
                      <span className={`text-xs font-semibold ${v.action === 'longer' ? 'text-up' : v.action === 'shorter' ? 'text-down' : 'text-muted'}`}>
                        {v.action === 'longer' ? 'waiting longer' : v.action === 'shorter' ? 'selling sooner' : 'keep'}
                      </span>
                    </div>
                    <div className="text-xs text-muted">
                      {v.n} exits · {v.ranPct}% ran +25% after · typical coin ended {v.medianEndX}x of the exit · best after avg {v.avgMaxAfterX}x
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Everything it changed">
            {!data.changes.length ? (
              <p className="text-sm text-ink-2">No changes yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.changes.map((c, i) => (
                  <li key={`${c.at}-${i}`} className="py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 break-words font-medium text-ink">{c.what}</span>
                      <span className="shrink-0 text-xs text-muted">{ago(c.at)}</span>
                    </div>
                    <div className="break-words text-xs text-muted">{c.why}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted">{label}</div>
      <div className="font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
