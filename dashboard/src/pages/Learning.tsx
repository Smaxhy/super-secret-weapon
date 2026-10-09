/** What the bot has learned: weights, pattern odds, market mood, and what it got wrong. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatTile } from '../components/ui';
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
  good_cut: 'Good cut', sold_too_early: 'Sold too early', good_exit: 'Good exit', rug: 'Rug',
};
const STRAT: Record<string, string> = { CURVE_SNIPE: 'Curve snipe', SOON: 'Soon', MIGRATION_MOMENTUM: 'Migration', SMART_MONEY_COPY: 'Copy' };

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

export function Learning() {
  const { data: d, error, loading, reload } = useApi<LearnerData>('/api/learner', 60_000);
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
        subtitle={d ? `Every scored coin is tracked for an hour: did it reach ${d.winMultiple}× before dropping 30%? Weights adjust every 20 min and after every closed trade — own trades count 3×, losses count extra, and a change is only kept if it would have picked recent coins better.` : undefined}
        action={
          <button type="button" onClick={() => void adjustNow()} disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {busy ? 'Adjusting…' : '↻ Adjust weights now'}
          </button>
        }
      />
      {msg && <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink" role="status">{msg}</div>}
      {error && <ErrorBox message={error} />}
      {d && r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Market mood" value={<span className={r.cls}><span aria-hidden="true">{r.icon}</span> {r.label}</span>} sub={r.note} />
            <StatTile label="Outcomes checked (24h)" value={num(d.labeled24h)} />
            <StatTile label={`Reached ${d.winMultiple}× (24h)`} value={pct(d.hitRate24h, 1)} sub="of all scored coins" />
            <StatTile label="Weights version" value={`v${d.weightsVersion}`} sub={d.history[0] ? `updated ${ago(d.history[0].createdAt)}` : 'still the defaults'} />
          </div>

          <Card title="Did the bot's decisions hold up? (24h)" className="mt-4">
            {d.byDecision.length ? (
              <table className="w-full text-sm tabular">
                <thead>
                  <tr className="text-left text-ink-2">
                    <th className="pb-2 font-medium">Decision</th>
                    <th className="pb-2 font-medium">Coins</th>
                    <th className="pb-2 font-medium">Average best price after</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byDecision.map((x) => (
                    <tr key={x.decision} className="border-t border-line text-ink">
                      <td className="py-2">{x.decision === 'BUY' ? '✓ Bought' : x.decision === 'REJECT' ? '✕ Rejected' : '– Skipped'}</td>
                      <td>{num(x.count)}</td>
                      <td>{x.avgMax ? `${x.avgMax.toFixed(2)}×` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Outcomes appear one hour after coins are scored.</Empty>
            )}
            <p className="mt-2 text-sm text-muted">Good learning = bought coins average a clearly higher best price than skipped ones.</p>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card title="Score weights (how much each signal counts)">
              <ul className="space-y-2">
                {[...d.weights].sort((a, b) => b.weight - a.weight).map((w) => {
                  const diff = w.weight - w.default;
                  return (
                    <li key={w.feature} className="grid grid-cols-[minmax(0,9rem)_1fr_4.5rem] items-center gap-3 text-sm">
                      <span className="truncate text-ink-2">{FEATURE_LABEL[w.feature] ?? w.feature}</span>
                      <span className="relative h-2 rounded-full bg-[color-mix(in_srgb,var(--series-1)_15%,transparent)]">
                        <span className="block h-2 rounded-full bg-[var(--series-1)]" style={{ width: `${(w.weight / maxW) * 100}%` }} />
                        <span className="absolute top-[-3px] h-[14px] w-[2px] bg-ink-2" style={{ left: `${(w.default / maxW) * 100}%` }} title="default" aria-hidden="true" />
                      </span>
                      <span className="tabular text-right text-ink">
                        {(w.weight * 100).toFixed(1)}%
                        {Math.abs(diff) >= 0.0005 && <span className={diff > 0 ? 'text-up' : 'text-down'}> {diff > 0 ? '▲' : '▼'}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-sm text-muted">Bar = weight now. Tick = the starting default. ▲▼ = learned change.</p>
            </Card>

            <Card title={`Pattern odds (chance of reaching ${d.winMultiple}×)`}>
              {d.beliefs.length ? (
                <ul className="space-y-2">
                  {d.beliefs.map((b) => (
                    <li key={b.pattern} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(9rem,13rem)_1fr_6rem]">
                      <span className="min-w-0 break-words text-ink-2">{b.pattern}</span>
                      <span className="col-span-2 row-start-2 h-2 rounded-full bg-[color-mix(in_srgb,var(--series-1)_15%,transparent)] sm:col-span-1 sm:col-start-2 sm:row-start-1">
                        <span className="block h-2 rounded-full bg-[var(--series-1)]" style={{ width: `${Math.min(100, b.winRate)}%` }} />
                      </span>
                      <span className="tabular whitespace-nowrap text-right text-ink">
                        {b.winRate.toFixed(1)}% <span className="text-muted">n={b.observations}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Fills in as outcomes are checked.</Empty>
              )}
            </Card>
          </div>

          <Card title="Trade coach (learns from every trade)" className="mt-4">
            <p className="mb-3 text-sm text-ink-2">30 min after each trade it checks what the price did next, names the mistake, and adjusts that strategy: buy bar, size, stop and trail.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(d.coach?.states ?? []).map((c) => (
                <div key={c.strategy} className="min-w-0 rounded-lg border border-line p-3 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-ink">{STRAT[c.strategy] ?? c.strategy}</span>
                    <span className="text-muted">{c.trades} reviewed{c.winRatePct !== null ? ` · ${c.winRatePct}% wins` : ''}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 tabular-nums text-ink-2">
                    <span>bar {c.thresholdDelta > 0 ? '+' : ''}{c.thresholdDelta}</span>
                    <span>size ×{c.sizeFactor}</span>
                    <span>stop {c.stopBiasPct > 0 ? '+' : ''}{c.stopBiasPct}%</span>
                    <span>trail ×{c.trailFactor}</span>
                  </div>
                  {c.note && <p className="mt-1 break-words text-xs text-muted">{c.note}</p>}
                </div>
              ))}
            </div>
            {d.coach && d.coach.reviews.length > 0 ? (
              <ul className="mt-3 divide-y divide-line text-sm">
                {d.coach.reviews.slice(0, 10).map((r) => (
                  <li key={r.positionId} className="py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold text-ink">
                        {r.symbol} <span className="font-normal text-muted">· {STRAT[r.strategy] ?? r.strategy}{r.swing ? ' · swing' : ''}</span>
                      </span>
                      <span className={r.pnlSol > 0 ? 'text-up' : 'text-down'}>{VERDICT[r.verdict] ?? r.verdict}</span>
                    </div>
                    <div className="break-words text-ink-2">{r.lesson}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Lessons appear 30 minutes after each closed trade.</Empty>
            )}
          </Card>

          <Card title="Do high scores win? (last 7 days)" className="mt-4">
            <p className="mb-2 text-sm text-ink-2">Real win rate per score band. Bands that lose more than average get points taken off and smaller size automatically.</p>
            {d.calibration && d.calibration.bands.some((b) => b.n >= 5) ? (
              <div className="space-y-3">
                {Object.entries(d.calibration.base).map(([strategy, base]) => (
                  <div key={strategy} className="min-w-0 text-sm">
                    <div className="font-semibold text-ink">
                      {STRAT[strategy] ?? strategy} <span className="font-normal text-muted">· {Math.round(base.winRate * 100)}% overall (n={base.n})</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {d.calibration!.bands
                        .filter((b) => b.strategy === strategy && b.n >= 5)
                        .map((b) => (
                          <span key={b.lo} className={`rounded-md border border-line px-2 py-0.5 tabular-nums ${b.winRate < base.winRate * 0.8 ? 'text-down' : b.winRate > base.winRate * 1.2 ? 'text-up' : 'text-ink-2'}`}>
                            {b.lo}–{b.hi}: {Math.round(b.winRate * 100)}% <span className="text-muted">({b.n})</span>
                          </span>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>Fills in as scored coins get their 1-hour result.</Empty>
            )}
          </Card>

          <Card title="Smart wallets it found" className="mt-4">
            {d.smartWallets && d.smartWallets.wallets.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {d.smartWallets.wallets.map((w) => (
                  <li key={w.wallet} className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate font-mono text-ink">{w.wallet.slice(0, 4)}…{w.wallet.slice(-4)}</span>
                    <span className="shrink-0 tabular-nums text-up">
                      {(w.winRate * 100).toFixed(0)}% <span className="text-muted">n={w.n}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Builds up as coins get labelled — wallets that keep buying early into winners show here (and boost coins they buy).</Empty>
            )}
          </Card>

          <Card title="Learning status" className="mt-4">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div className="min-w-0"><div className="text-muted">Last adjust</div><div className="font-medium text-ink">{d.lastAdjustAt ? ago(d.lastAdjustAt) : '—'}</div></div>
              <div className="min-w-0"><div className="text-muted">Next adjust</div><div className="font-medium text-ink">{d.nextAdjustAt ? new Date(d.nextAdjustAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</div></div>
              <div className="min-w-0"><div className="text-muted">Clean labels</div><div className="font-medium text-ink">{d.labelStats ? `${d.labelStats.wins} W / ${d.labelStats.losses} L` : '—'}</div></div>
              <div className="min-w-0"><div className="text-muted">Bad data ignored</div><div className="font-medium text-ink">{d.labelStats?.excluded ?? 0}</div></div>
            </div>
            {d.adjustments && d.adjustments.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {d.adjustments.slice(0, 5).map((a) => (
                  <li key={a.at} className="min-w-0 break-words">
                    <span className={a.accepted ? 'text-up' : 'text-muted'}>{a.accepted ? '✓ kept' : '– skipped'}</span>{' '}
                    <span className="text-muted">{ago(a.at)} · {a.trigger.replace('_', ' ')}</span> <span className="text-ink-2">{a.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card title="Words that win">
              <KeywordList rows={d.keywords?.good ?? []} cls="text-up" />
            </Card>
            <Card title="Words that lose">
              <KeywordList rows={d.keywords?.bad ?? []} cls="text-down" />
            </Card>
          </div>

          <Card title="What changed and why" className="mt-4">
            {d.history.length ? (
              <ul className="space-y-4">
                {d.history.map((h) => (
                  <li key={h.version}>
                    <div className="font-medium text-ink">
                      v{h.version} {h.active && <span className="text-up">(active)</span>} <span className="font-normal text-muted">· {ago(h.createdAt)}</span>
                    </div>
                    <div className="text-sm text-ink-2">{h.reason}</div>
                    {h.changes && h.changes.length > 0 && (
                      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        {h.changes.slice(0, 8).map((c) => (
                          <li key={c.feature} className={c.to > c.from ? 'text-up' : 'text-down'}>
                            {c.to > c.from ? '▲' : '▼'} {FEATURE_LABEL[c.feature] ?? c.feature} {(c.from * 100).toFixed(1)}→{(c.to * 100).toFixed(1)}%
                            <span className="text-muted"> (winners {c.winnersAvg.toFixed(2)} vs losers {c.losersAvg.toFixed(2)})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No adjustments yet. The first needs 100+ checked coins with 10+ winners.</Empty>
            )}
          </Card>

          <Card title="Mistakes it's learning from" className="mt-4">
            {d.missed.length ? (
              <ul className="divide-y divide-line">
                {d.missed.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <Link to={`/token/${m.mint}`} className="font-semibold text-ink hover:underline">
                      {m.symbol}
                    </Link>
                    <span className={m.decision === 'BUY' ? 'text-down' : 'text-up'}>{m.outcome}</span>
                    <span className="text-muted">
                      score {m.scoreAtDecision.toFixed(0)} · {ago(m.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>None yet — skipped coins that later ran 2×, or buys that fell 40%, show up here.</Empty>
            )}
          </Card>
        </>
      )}
    </>
  );
}
