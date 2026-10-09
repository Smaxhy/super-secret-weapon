import { Link } from 'react-router-dom';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { ago, multiple, num, pct, price, sol, STRATEGY_LABEL } from '../lib/format';
import type { OpenPosition } from '../lib/types';

export function Positions() {
  const { data, error, loading } = useApi<OpenPosition[]>('/api/positions', 3_000);
  return (
    <>
      <PageHeader title="Open positions" subtitle="Updates every 3 seconds. Manual sell arrives with the Controls page (Phase 5)." />
      {error && <ErrorBox message={error} />}
      {loading && !data ? <Loading /> : !data?.length ? <Empty>No open positions right now.</Empty> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((p) => {
          const m = p.multiple ?? 0;
          return (
            <Card
              key={p.id}
              title={
                <Link to={`/token/${p.mint}`} className="hover:underline">
                  {p.symbol} <span className="font-normal text-ink-2">· {STRATEGY_LABEL[p.strategy] ?? p.strategy}</span>
                </Link>
              }
              action={<span className="text-sm text-muted">opened {ago(p.openedAt)}</span>}
            >
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
                <Field label="Score at entry">{p.scoreAtEntry?.toFixed(1) ?? '—'}</Field>
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
                  <li>{p.trailingActive ? `Trailing stop at ${price(p.targets.trailingStopPrice)}` : 'Trailing stop starts at 2×'}</li>
                </ul>
              </div>

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
    <div>
      <div className="text-sm text-muted">{label}</div>
      <div className="tabular text-ink">{children}</div>
    </div>
  );
}
