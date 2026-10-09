import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBotEvents, type BotEvent } from '../hooks/useWebSocket';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { ago, multiple, num, pct, price, sol, STRATEGY_LABEL } from '../lib/format';
import type { OpenPosition } from '../lib/types';

interface LiveUpdate {
  id: string;
  priceSol: number;
  multiple: number;
  peakMultiple: number;
  unrealizedPnlSol: number;
  risk: number;
  holders: number;
  ownSupplyPct: number;
  exitImpactPct: number;
}

export function Positions() {
  const { data, error, loading } = useApi<OpenPosition[]>('/api/positions', 10_000, ['trade']);
  // The bot pushes every open position's price every ~2s; overlay it on the last full load.
  const [live, setLive] = useState<Record<string, LiveUpdate & { at: number }>>({});
  const onEvent = useCallback((e: BotEvent) => {
    if (e.type !== 'positions') return;
    const now = Date.now();
    const next: Record<string, LiveUpdate & { at: number }> = {};
    for (const u of (e.data as { updates: LiveUpdate[] }).updates) next[u.id] = { ...u, at: now };
    setLive((prev) => ({ ...prev, ...next }));
  }, []);
  useBotEvents(onEvent);
  return (
    <>
      <PageHeader title="Open positions" subtitle="Prices stream live from the bot every ~2 seconds." />
      {error && <ErrorBox message={error} />}
      {loading && !data ? <Loading /> : !data?.length ? <Empty>No open positions right now.</Empty> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((base) => {
          const u = live[base.id];
          const p = u
            ? { ...base, currentPriceSol: u.priceSol, multiple: u.multiple, unrealizedPnlSol: u.unrealizedPnlSol, peakPriceSol: Math.max(base.peakPriceSol, u.peakMultiple * base.entryPriceSol), health: base.health ? { ...base.health, holders: u.holders } : base.health }
            : base;
          const m = p.multiple ?? 0;
          const risk = u?.risk;
          return (
            <Card
              key={p.id}
              title={
                <Link to={`/token/${p.mint}`} className="hover:underline">
                  {p.symbol} <span className="font-normal text-ink-2">· {STRATEGY_LABEL[p.strategy] ?? p.strategy}</span>
                </Link>
              }
              action={
                <span className="flex items-center gap-2 text-sm text-muted">
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
                  <li>{p.trailingActive ? `Trailing stop at ${price(p.targets.trailingStopPrice)}` : 'Trailing stop starts at 2×'}</li>
                </ul>
              </div>

              {u && (
                <div className="mt-3 text-sm text-ink-2">
                  You hold <span className="tabular text-ink">{u.ownSupplyPct.toFixed(2)}%</span> of the supply · selling it all now would move the price{' '}
                  <span className={`tabular ${u.exitImpactPct > 5 ? 'text-down' : 'text-ink'}`}>−{u.exitImpactPct.toFixed(1)}%</span>
                </div>
              )}
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
    <div>
      <div className="text-sm text-muted">{label}</div>
      <div className="tabular text-ink">{children}</div>
    </div>
  );
}
