import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { McCompare } from '../components/McCompare';
import { PositionChart } from '../components/PositionChart';
import { DipWatch } from '../components/DipWatch';
import { useLivePositions } from '../hooks/useLivePositions';
import { ago, multiple, num, pct, price, sol, STRATEGY_LABEL } from '../lib/format';

export function Positions() {
  // API data + live WebSocket prices (every ~2s), merged in one hook.
  const { positions: data, error, loading, reload } = useLivePositions();
  return (
    <>
      <PageHeader title="Open positions" subtitle="Prices and market caps update live on every trade. Tap Sell now to exit manually." />
      <DipWatch />
      {error && <ErrorBox message={error} />}
      {loading && !data ? <Loading /> : !data?.length ? <Empty>No open positions right now.</Empty> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((p) => {
          const u = p.live;
          const m = p.multiple ?? 0;
          const risk = u?.risk;
          return (
            <Card
              key={p.id}
              title={
                <Link to={`/token/${p.mint}`} className="flex min-w-0 flex-col hover:underline sm:flex-row sm:items-baseline sm:gap-1">
                  <span className="truncate">{p.symbol}</span>
                  <span className="shrink-0 text-sm font-normal text-ink-2 sm:text-base">
                    <span className="hidden sm:inline">· </span>
                    {STRATEGY_LABEL[p.strategy] ?? p.strategy}
                  </span>
                </Link>
              }
              action={
                <span className="flex items-center gap-2 whitespace-nowrap text-sm text-muted">
                  {u && Date.now() - u.at < 6_000 && (
                    <span className="inline-flex items-center gap-1 text-up">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-good" aria-hidden="true" />
                      live
                    </span>
                  )}
                  opened {ago(p.openedAt)}
                </span>
              }
            >
              <McCompare p={p} />

              <div className="mt-4">
                <PositionChart position={p} />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Field label="Now">
                  <span className={`text-2xl font-semibold ${m >= 1 ? 'text-up' : 'text-down'}`}>{multiple(p.multiple)}</span>
                </Field>
                <Field label="Unrealised">
                  <Pnl value={p.unrealizedPnlSol} />
                </Field>
                <Field label="Banked">
                  <Pnl value={p.realizedPnlSol} />
                </Field>
                <Field label="Size">
                  {sol(p.sizeSol, 2)} <span className="text-muted">({pct(p.remainingPct, 0)} left)</span>
                </Field>
                <Field label="Entry price">{price(p.entryPriceSol)}</Field>
                <Field label="Current price">{price(p.currentPriceSol)}</Field>
                <Field label="Peak">{multiple(p.peakPriceSol / p.entryPriceSol)}</Field>
                <Field label="Exit risk">
                  {risk === undefined ? '—' : <span className={risk >= 0.6 ? 'text-down' : risk >= 0.35 ? 'text-warning' : 'text-up'}>{risk >= 0.6 ? 'High' : risk >= 0.35 ? 'Rising' : 'Low'} ({Math.round(risk * 100)})</span>}
                </Field>
              </div>

              <div className="mt-4 border-t border-line pt-3 text-sm">
                <div className="mb-1 font-medium text-ink">Exit targets</div>
                <ul className="flex flex-wrap gap-x-5 gap-y-1 text-ink-2">
                  <li>Stop loss {price(p.targets.stopLossPrice)}</li>
                  {p.targets.takeProfits.map((t) => (
                    <li key={t.multiple}>
                      {t.hit ? '✓' : '○'} Sell {t.sellPct}% at {t.multiple}×
                    </li>
                  ))}
                  <li>{p.targets.trailingStopPrice !== null ? `Trailing stop at ${price(p.targets.trailingStopPrice)}` : 'Trailing stop not active yet'}</li>
                </ul>
              </div>

              {u && (
                <div className="mt-3 text-sm text-ink-2">
                  You hold <span className="tabular text-ink">{u.ownSupplyPct.toFixed(2)}%</span> of the supply · selling it all now would move the price{' '}
                  <span className={`tabular ${u.exitImpactPct > 5 ? 'text-down' : 'text-ink'}`}>−{u.exitImpactPct.toFixed(1)}%</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => window.confirm(`Sell all of ${p.symbol} now?`) && void api(`/api/positions/${p.id}/sell`, { method: 'POST' }).then(() => reload())}
                className="mt-3 w-full rounded-lg border border-critical py-2.5 text-sm font-semibold text-down sm:w-auto sm:px-5"
              >
                Sell now
              </button>
              {p.buyReason && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-ink-2">Why it bought</summary>
                  <p className="mt-1 leading-relaxed text-ink">{p.buyReason}</p>
                </details>
              )}
              {p.health && (
                <div className="mt-3 text-sm text-ink-2">
                  Health: {num(p.health.holders)} holders · dev {pct(p.health.devHoldingPct)} · top 10 {pct(p.health.top10HolderPct)} · curve {pct(p.health.curvePct)}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm text-muted">{label}</div>
      <div className="tabular break-words text-ink">{children}</div>
    </div>
  );
}
