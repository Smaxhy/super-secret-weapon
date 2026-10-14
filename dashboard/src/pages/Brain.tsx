/**
 * Brain: what the self-improving learners know — the win-probability model (and whether it has earned a say),
 * rules the statistical search discovered (testing → live), how the budget is shifted between strategies,
 * the learned entry styles and every change the bot made.
 */
import { BrainTips } from '../components/BrainTips';
import { Card, Empty, ErrorBox, Loading, PageHeader, Row, Rows, Stack, Stat, Tabs, useTab } from '../components/ui';
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
  lossExits?: Array<{ kind: string; label: string; n: number; avgPnlPct: number; backAbovePct: number; diedPct: number; overshootPts: number | null; verdict: 'good' | 'false_alarm' | 'late' | 'mixed'; why: string }>;
  exitTimers?: Array<{ strategy: string; timer: string; n: number; ranPct: number; medianEndX: number; avgMaxAfterX: number; action: 'longer' | 'shorter' | 'keep'; why: string }>;
}
const TIMER: Record<string, string> = { timeStop: 'No follow-through', stall: 'Stalled', stale: 'Stale (no movement)', maxHold: 'Max hold' };

const strat = (s: string) => STRATEGY_LABEL[s] ?? s;
const STATUS: Record<Discovered['status'], string> = { testing: 'testing on new trades', live: 'LIVE', retired: 'retired' };
const r2 = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '—');

const TABS = [
  { key: 'talk', label: 'Talk' },
  { key: 'models', label: 'Models' },
  { key: 'rules', label: 'Rules' },
  { key: 'budget', label: 'Budget' },
  { key: 'changes', label: 'Changes' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export function Brain() {
  const { data, error } = useApi<BrainData | null>('/api/brain', 60_000);
  const [tab, setTab] = useTab<Tab>('brain', TABS.map((t) => t.key), 'talk');
  return (
    <>
      <PageHeader title="Brain" subtitle="What it learned on its own. Nothing goes live before it proves itself on new trades." />
      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} sticky label="Brain sections" />
      {tab === 'talk' && <BrainTips />}
      {tab !== 'talk' && error && <ErrorBox message={error} />}
      {tab !== 'talk' && !data && !error && <Loading />}
      {tab !== 'talk' && data === null && !error && <Empty>The brain starts a few minutes after the bot starts.</Empty>}
      {tab === 'models' && data && (
        <Stack>
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
        </Stack>
      )}
      {tab === 'rules' && data && (
        <Stack>
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
                    <li key={r.title} className="py-2 first:pt-0 last:pb-0">
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

          {data.entryStyles.length > 0 && (
            <Card title="How it enters now (learned)">
              <Rows>
                {data.entryStyles.map((s) => (
                  <li key={s.strategy} className="py-2 first:pt-0 last:pb-0">
                    <div className="font-medium text-ink">{strat(s.strategy)}</div>
                    <div className="text-ink-2">{[s.minOffHighPct ? `Waits until ${s.minOffHighPct}%+ under the 10-min high` : '', s.maxRun3mPct !== null ? `no chasing above +${s.maxRun3mPct}% in 3 min` : ''].filter(Boolean).join(' · ')}</div>
                    <div className="text-xs text-muted">{s.why.join(' · ')}</div>
                  </li>
                ))}
              </Rows>
            </Card>
          )}
          <Card title="Exit timers" subtitle="What coins did in the 30 minutes after a time-based sell.">
            {!data.exitTimers?.length ? (
              <p className="text-sm text-ink-2">Collecting: every time-based exit is followed for 30 minutes after the sell.</p>
            ) : (
              <Rows>
                {data.exitTimers.map((v) => (
                  <Row
                    key={`${v.strategy}:${v.timer}`}
                    label={<span className="font-medium text-ink">{strat(v.strategy)} · {TIMER[v.timer] ?? v.timer}</span>}
                    sub={`${v.n} exits · ${v.ranPct}% ran +25% after · typical coin ended ${v.medianEndX}x of the exit · best after avg ${v.avgMaxAfterX}x`}
                    value={<span className="text-xs">{v.action === 'longer' ? 'Waiting longer' : v.action === 'shorter' ? 'Selling sooner' : 'Keep'}</span>}
                    tone={v.action === 'longer' ? 'up' : v.action === 'shorter' ? 'down' : 'muted'}
                  />
                ))}
              </Rows>
            )}
          </Card>
          <Card title="Stop-loss & rug exits" subtitle="Every loss exit followed for 30 minutes: did the coin really die (good exit) or come back above our entry (false alarm)?">
            {!data.lossExits?.length ? (
              <p className="text-sm text-ink-2">Collecting: every stop-loss and rug exit is followed for 30 minutes after the sell.</p>
            ) : (
              <Rows>
                {data.lossExits.map((v) => (
                  <Row
                    key={v.kind}
                    label={<span className="font-medium text-ink">{v.label}</span>}
                    sub={`${v.n} exits · avg ${v.avgPnlPct}% · ${v.backAbovePct}% came back above entry · ${v.diedPct}% kept collapsing${v.overshootPts !== null ? ` · ${v.overshootPts} pts past the stop` : ''}`}
                    value={<span className="text-xs">{v.verdict === 'good' ? 'Saves money' : v.verdict === 'false_alarm' ? 'Too twitchy' : v.verdict === 'late' ? 'Too late' : 'Mixed'}</span>}
                    tone={v.verdict === 'good' ? 'up' : v.verdict === 'mixed' ? 'muted' : 'down'}
                  />
                ))}
              </Rows>
            )}
          </Card>
        </Stack>
      )}
      {tab === 'budget' && data && (
        <Stack>
          <Card title="Budget per strategy" subtitle="Strategies that earn get more money per trade; losing ones get less.">
            {!data.allocation?.length ? (
              <p className="text-sm text-ink-2">Every strategy on its normal budget until there's enough evidence (~10 trades each).</p>
            ) : (
              <Rows>
                {data.allocation.map((a) => (
                  <Row
                    key={a.strategy}
                    label={<span className="font-medium text-ink">{strat(a.strategy)}</span>}
                    sub={`${a.n} trades · likely ${a.meanPct >= 0 ? '+' : ''}${a.meanPct.toFixed(1)}% per trade · ${a.why}`}
                    value={`×${a.multiplier.toFixed(2)}`}
                    tone={a.multiplier > 1.05 ? 'up' : a.multiplier < 0.95 ? 'down' : 'muted'}
                  />
                ))}
              </Rows>
            )}
          </Card>
        </Stack>
      )}
      {tab === 'changes' && data && (
        <Stack>
          <Card title="Everything it changed">
            {!data.changes.length ? (
              <p className="text-sm text-ink-2">No changes yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.changes.map((c, i) => (
                  <li key={`${c.at}-${i}`} className="py-2 first:pt-0 last:pb-0">
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
        </Stack>
      )}
    </>
  );
}
