/** What the bot has learned: weights, pattern odds, market mood, and what it got wrong. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, Row, Rows, StatTile, Tabs, Timeline, useTab } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, num, pct } from '../lib/format';

interface LearnerData {
  winMultiple: number;
  weightsVersion: number;
  weights: Array<{ feature: string; weight: number; default: number }>;
  history: Array<{ version: number; active: boolean; reason: string; createdAt: string; changes: Array<{ feature: string; from: number; to: number; winnersAvg: number; losersAvg: number }> | null }>;
  beliefs: Array<{ pattern: string; winRate: number; observations: number }>;
  regime: 'HOT' | 'NORMAL' | 'COLD' | 'RUG_HEAVY';
  regimeHistory: Array<{ t: string; regime: string; stats: { launchesPerHour: number; migrationRatePct: number; hitRatePct: number | null; rugRatePct: number | null } }>;
  missed: Array<{ id: string; mint: string; symbol: string; decision: string; scoreAtDecision: number; peakMultiple: number | null; outcome: string; createdAt: string }>;
  labeled24h: number;
  hitRate24h: number | null;
  byDecision: Array<{ decision: string; count: number; avgMax: number | null }>;
  lastAdjustAt?: string | null;
  nextAdjustAt?: string | null;
  adjustments?: Array<{ at: string; trigger: string; accepted: boolean; aucBefore: number | null; aucAfter: number | null; message: string }>;
  labelStats?: { wins: number; losses: number; excluded: number; winRate: number | null } | null;
  keywords?: { good: KeywordRow[]; bad: KeywordRow[]; baseRate: number } | null;
  coach?: {
    states: Array<{ strategy: string; trades: number; winRatePct: number | null; lossStreak: number; thresholdDelta: number; sizeFactor: number; stopBiasPct: number; trailFactor: number; note: string }>;
    reviews: Array<{ positionId: string; symbol: string; strategy: string; pnlSol: number; verdict: string; lesson: string; at: string; swing: boolean }>;
  } | null;
  smartWallets?: { wallets: Array<{ wallet: string; winRate: number; n: number }>; baseRate: number; tracked: number } | null;
  calibration?: { bands: Array<{ strategy: string; lo: number; hi: number; n: number; winRate: number }>; base: Record<string, { n: number; winRate: number }> } | null;
}

const VERDICT: Record<string, string> = {
  late_entry: 'Late entry', gave_back_profit: 'Gave back profit', stopped_then_ran: 'Stopped, then it ran', slow_loser: 'Slow loser',
  good_cut: 'Good cut', sold_too_early: 'Sold too early', good_exit: 'Good exit', rug: 'Rug', manual_exit: 'You closed it',
};
const STRAT: Record<string, string> = { CURVE_SNIPE: 'New pair', SOON: 'Soon', MIGRATION_MOMENTUM: 'Migration', SMART_MONEY_COPY: 'Copy', SWING: 'Swing', RUNNER: 'Runner' };

interface KeywordRow { word: string; winRate: number; n: number }

function KeywordList({ rows, cls }: { rows: KeywordRow[]; cls: string }) {
  if (!rows.length) return <Empty>Needs 8+ results per word.</Empty>;
  return (
    <ul className="space-y-1 text-sm">
      {rows.slice(0, 10).map((k) => (
        <li key={k.word} className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate font-medium text-ink">{k.word}</span>
          <span className={`shrink-0 tabular-nums ${cls}`}>
            {(k.winRate * 100).toFixed(0)}% <span className="text-muted">n={Math.round(k.n)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const FEATURE_LABEL: Record<string, string> = {
  safety: 'Safety', holders: 'Holders', buyPressure: 'Buy pressure', volume: 'Volume', curveVelocity: 'Momentum', distribution: 'Distribution',
  devHolding: 'Dev holding', devBehavior: 'Dev not selling', snipers: 'Few bundlers', retention: 'Holder retention', creatorLaunches: 'Not a serial launcher',
  creatorSuccess: "Dev's past success", funderReuse: 'Funding source', walletAge: 'Dev wallet age', socials: 'Socials', narrative: 'Narrative',
  crowd: 'Crowd behaviour', attention: 'Eyes on it',
};

const REGIME: Record<LearnerData['regime'], { icon: string; label: string; note: string; cls: string }> = {
  HOT: { icon: '▲', label: 'Hot', note: 'Lots of winners — slightly bigger size, slightly easier buy bar.', cls: 'text-up' },
  NORMAL: { icon: '●', label: 'Normal', note: 'Default size and buy bar.', cls: 'text-ink' },
  COLD: { icon: '▼', label: 'Cold', note: 'Few winners / quiet market — smaller size, stricter buy bar.', cls: 'text-warning' },
  RUG_HEAVY: { icon: '✕', label: 'Rug-heavy', note: 'Many tokens dumping — half size, much stricter buy bar.', cls: 'text-down' },
};

const TABS = [
  { key: 'score', label: 'Score' },
  { key: 'coach', label: 'Coach' },
  { key: 'signals', label: 'Signals' },
  { key: 'history', label: 'History' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export function Learning() {
  const { data: d, error, loading, reload } = useApi<LearnerData>('/api/learner', 60_000);
  const [tab, setTab] = useTab<Tab>('learning', TABS.map((t) => t.key), 'score');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function adjustNow() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/learner/adjust', { method: 'POST' });
      setMsg(r.message);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !d) return <Loading />;
  const r = d ? REGIME[d.regime] : null;
  const maxW = d ? Math.max(...d.weights.map((w) => Math.max(w.weight, w.default))) : 1;

  return (
    <>
      <PageHeader
        title="Learning"
        subtitle={d ? `Every scored coin is followed for an hour (did it reach ${d.winMultiple}× first?). Weights adjust every 20 min and only when they'd have picked recent coins better.` : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => void adjustNow()} disabled={busy}>
            <Icon name="refresh" size={15} />
            {busy ? 'Adjusting…' : 'Adjust now'}
          </Button>
        }
      />
      {msg && <div className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink" role="status">{msg}</div>}
      {error && <ErrorBox message={error} />}
      {d && r && (
        <section aria-label="Learning status" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile compact label="Market mood" value={<span className={r.cls}>{r.label}</span>} sub={r.note} />
          <StatTile compact label="Outcomes checked (24 h)" value={num(d.labeled24h)} sub={d.labelStats ? `${d.labelStats.wins} W / ${d.labelStats.losses} L clean labels` : undefined} />
          <StatTile compact label={`Reached ${d.winMultiple}× (24 h)`} value={pct(d.hitRate24h, 1)} sub="of all scored coins" />
          <StatTile compact label="Weights" value={`v${d.weightsVersion}`} sub={d.lastAdjustAt ? `last adjust ${ago(d.lastAdjustAt)}` : d.history[0] ? `updated ${ago(d.history[0].createdAt)}` : 'still the defaults'} />
        </section>
      )}
      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} sticky label="Learning sections" />

      {d && tab === 'score' && (
        <div className="grid gap-6 xl:grid-cols-12">
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-7">
            <Card title="Score weights" subtitle="How much each signal counts. Tick = the starting default; arrow = what it learned.">
              <ul className="space-y-2.5">
                {[...d.weights].sort((a, b) => b.weight - a.weight).map((w) => {
                  const diff = w.weight - w.default;
                  return (
                    <li key={w.feature} className="grid grid-cols-[minmax(0,8rem)_1fr_4.5rem] items-center gap-3 text-sm sm:grid-cols-[minmax(0,11rem)_1fr_5rem]" title={`${FEATURE_LABEL[w.feature] ?? w.feature}: ${(w.weight * 100).toFixed(1)}% (default ${(w.default * 100).toFixed(1)}%)`}>
                      <span className="truncate text-ink-2">{FEATURE_LABEL[w.feature] ?? w.feature}</span>
                      <span className="relative h-2.5 rounded-full bg-surface-2">
                        <span className="block h-2.5 rounded-full bg-accent" style={{ width: `${(w.weight / maxW) * 100}%` }} />
                        <span className="absolute top-[-3px] h-[16px] w-[2px] rounded bg-ink-2" style={{ left: `${(w.default / maxW) * 100}%` }} aria-hidden="true" />
                      </span>
                      <span className="tabular text-right text-ink">
                        {(w.weight * 100).toFixed(1)}%
                        {Math.abs(diff) >= 0.0005 && <span className={diff > 0 ? 'text-up' : 'text-down'}> {diff > 0 ? '▲' : '▼'}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <Card title="Do high scores win?" subtitle="Last 7 days per 5-point band. Losing bands get points off and a smaller size automatically.">
              {d.calibration && d.calibration.bands.some((b) => b.n >= 5) ? (
                <div className="space-y-4">
                  {Object.entries(d.calibration.base).map(([strategy, base]) => {
                    const bands = d.calibration!.bands.filter((b) => b.strategy === strategy && b.n >= 5);
                    if (!bands.length) return null;
                    return (
                      <div key={strategy} className="min-w-0 text-sm">
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <span className="font-semibold text-ink">{STRAT[strategy] ?? strategy}</span>
                          <span className="tabular text-xs text-muted">{Math.round(base.winRate * 100)}% overall · n={base.n}</span>
                        </div>
                        <div className="flex gap-1">
                          {bands.map((b) => (
                            <div key={b.lo} className={`min-w-0 flex-1 rounded-lg px-1.5 py-1.5 text-center ${b.winRate < base.winRate * 0.8 ? 'bg-critical/12 text-down' : b.winRate > base.winRate * 1.2 ? 'bg-good/12 text-up' : 'bg-surface-2 text-ink-2'}`} title={`${b.lo}–${b.hi}: ${Math.round(b.winRate * 100)}% of ${b.n}`}>
                              <div className="tabular text-sm font-semibold">{Math.round(b.winRate * 100)}%</div>
                              <div className="tabular text-[10px] opacity-80">{b.lo}–{b.hi}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty>Fills in as scored coins get their 1-hour result.</Empty>
              )}
            </Card>
          </div>
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-5">
            <Card title="Did its decisions hold up?" subtitle="Last 24 h · bought coins should do clearly better than skipped ones.">
              {d.byDecision.length ? (
                <Rows>
                  {d.byDecision.map((x) => (
                    <Row key={x.decision} label={x.decision === 'BUY' ? 'Bought' : x.decision === 'REJECT' ? 'Rejected' : 'Skipped'} sub={`${num(x.count)} coins`} value={x.avgMax ? `${x.avgMax.toFixed(2)}× best after` : '—'} />
                  ))}
                </Rows>
              ) : (
                <Empty>Outcomes appear one hour after coins are scored.</Empty>
              )}
            </Card>
            <Card title={`Pattern odds`} subtitle={`Chance of reaching ${d.winMultiple}× by pattern`}>
              {d.beliefs.length ? (
                <ul className="space-y-2.5">
                  {d.beliefs.slice(0, 14).map((b) => (
                    <li key={b.pattern} className="text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-ink-2" title={b.pattern}>{b.pattern}</span>
                        <span className="tabular shrink-0 text-ink">{b.winRate.toFixed(1)}% <span className="text-xs text-muted">n={b.observations}</span></span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-surface-2">
                        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.min(100, b.winRate)}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Fills in as outcomes are checked.</Empty>
              )}
            </Card>
            <Card title="Weight adjustments" subtitle={d.nextAdjustAt ? `Next at ${new Date(d.nextAdjustAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${d.labelStats?.excluded ?? 0} bad labels ignored` : undefined}>
              {d.adjustments && d.adjustments.length > 0 ? (
                <Timeline items={d.adjustments.slice(0, 6).map((x) => ({ key: x.at, when: ago(x.at), title: x.accepted ? 'Kept new weights' : 'Kept the old weights', body: `${x.trigger.replace('_', ' ')} · ${x.message}`, tone: x.accepted ? 'up' : 'muted' }))} />
              ) : (
                <p className="text-sm text-muted">No adjustment runs yet.</p>
              )}
            </Card>
          </div>
        </div>
      )}

      {d && tab === 'coach' && (
        <div className="grid gap-6 xl:grid-cols-12">
          <Card title="Coach adjustments" subtitle="Per strategy: what the trade coach changed after reviewing its trades." className="xl:col-span-5">
            {(d.coach?.states ?? []).length ? (
              <ul className="divide-y divide-line text-sm">
                {(d.coach?.states ?? []).map((c) => (
                  <li key={c.strategy} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-ink">{STRAT[c.strategy] ?? c.strategy}</span>
                      <span className="tabular text-xs text-muted">{c.trades} reviewed{c.winRatePct !== null ? ` · ${c.winRatePct}% wins` : ''}{c.lossStreak ? ` · ${c.lossStreak} losses in a row` : ''}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
                      <Adj label="bar" value={`${c.thresholdDelta > 0 ? '+' : ''}${c.thresholdDelta}`} tone={c.thresholdDelta > 0 ? 'down' : c.thresholdDelta < 0 ? 'up' : undefined} />
                      <Adj label="size" value={`×${c.sizeFactor}`} tone={c.sizeFactor < 1 ? 'down' : undefined} />
                      <Adj label="stop" value={`${c.stopBiasPct > 0 ? '+' : ''}${c.stopBiasPct}%`} />
                      <Adj label="trail" value={`×${c.trailFactor}`} />
                    </div>
                    {c.note && <p className="mt-1.5 break-words text-xs text-muted">{c.note}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No reviews yet.</p>
            )}
          </Card>
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-7">
            <Card title="Lessons" subtitle="30 min after each trade it checks what the price did next and names the mistake.">
              {d.coach && d.coach.reviews.length > 0 ? (
                <Timeline
                  items={d.coach.reviews.slice(0, 12).map((x) => ({
                    key: x.positionId,
                    when: ago(x.at),
                    title: <span>{x.symbol} <span className="font-normal text-muted">· {STRAT[x.strategy] ?? x.strategy}{x.swing ? ' · swing' : ''} · </span><span className={x.pnlSol > 0 ? 'text-up' : 'text-down'}>{VERDICT[x.verdict] ?? x.verdict}</span></span>,
                    body: x.lesson,
                    tone: x.pnlSol > 0 ? 'up' : 'down',
                  }))}
                />
              ) : (
                <Empty>Lessons appear 30 minutes after each closed trade.</Empty>
              )}
            </Card>
            <Card title="Mistakes it's learning from" subtitle="Skipped coins that later ran 2×, or buys that fell 40%">
              {d.missed.length ? (
                <ul className="divide-y divide-line">
                  {d.missed.map((m) => (
                    <li key={m.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <Link to={`/token/${m.mint}`} className="font-semibold text-ink hover:underline">{m.symbol}</Link>
                      <span className={m.decision === 'BUY' ? 'text-down' : 'text-up'}>{m.outcome}</span>
                      <span className="tabular text-xs text-muted">score {m.scoreAtDecision.toFixed(0)} · {ago(m.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>None yet.</Empty>
              )}
            </Card>
          </div>
        </div>
      )}

      {d && tab === 'signals' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Smart wallets it found" subtitle="Wallets that keep buying early into winners (they boost coins they buy)">
            {d.smartWallets && d.smartWallets.wallets.length > 0 ? (
              <ul className="divide-y divide-line text-sm">
                {d.smartWallets.wallets.map((w) => (
                  <li key={w.wallet} className="flex min-h-10 min-w-0 items-center justify-between gap-2">
                    <span className="truncate font-mono text-ink" title={w.wallet}>{w.wallet.slice(0, 4)}…{w.wallet.slice(-4)}</span>
                    <span className="shrink-0 tabular-nums text-up">{(w.winRate * 100).toFixed(0)}% <span className="text-muted">n={w.n}</span></span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Builds up as coins get labelled.</Empty>
            )}
          </Card>
          <Card title="Words that win" subtitle={d.keywords ? `vs ${(d.keywords.baseRate * 100).toFixed(0)}% for any coin` : undefined}>
            <KeywordList rows={d.keywords?.good ?? []} cls="text-up" />
          </Card>
          <Card title="Words that lose">
            <KeywordList rows={d.keywords?.bad ?? []} cls="text-down" />
          </Card>
        </div>
      )}

      {d && tab === 'history' && (
        <Card title="What changed and why" subtitle="Every version of the score weights">
          {d.history.length ? (
            <Timeline
              items={d.history.map((h) => ({
                key: String(h.version),
                when: ago(h.createdAt),
                title: <span>v{h.version} {h.active && <Badge tone="up">active</Badge>}</span>,
                tone: h.active ? 'up' : 'muted',
                body: (
                  <>
                    <span className="text-ink-2">{h.reason}</span>
                    {h.changes && h.changes.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                        {h.changes.slice(0, 8).map((c) => (
                          <span key={c.feature} className={c.to > c.from ? 'text-up' : 'text-down'}>
                            {c.to > c.from ? '▲' : '▼'} {FEATURE_LABEL[c.feature] ?? c.feature} {(c.from * 100).toFixed(1)}→{(c.to * 100).toFixed(1)}%
                          </span>
                        ))}
                      </span>
                    )}
                  </>
                ),
              }))}
            />
          ) : (
            <Empty>No adjustments yet. The first needs 100+ checked coins with 10+ winners.</Empty>
          )}
        </Card>
      )}
    </>
  );
}

function Adj({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-lg bg-surface-2 px-1 py-1.5">
      <div className={`tabular text-sm font-semibold ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}
