/**
 * One open trade as a compact row: coin, strategy, live multiple and P&L, market cap bought-at → now,
 * how long it's been held, and a bar showing where the price sits between the stop and the next
 * take-profit. Tap the row for the chart, all the numbers, why it bought, and the Sell button.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LivePosition } from '../hooks/useLivePositions';
import { api } from '../lib/api';
import { ago, mcSol, multiple, num, pct, price, sol, STRATEGY_LABEL, usd } from '../lib/format';
import { Icon } from './Icon';
import { McChange, McCompare } from './McCompare';
import { PositionChart } from './PositionChart';
import { Badge, Button, Pnl } from './ui';

/** Where the price sits between the stop (left) and the next take-profit (right), entry marked. */
function RangeBar({ p }: { p: LivePosition }) {
  const e = p.entryPriceSol;
  const m = p.multiple;
  if (!(e > 0) || m === null) return null;
  const stopX = p.targets.stopLossPrice > 0 ? p.targets.stopLossPrice / e : 0.85;
  const next = p.targets.takeProfits.find((t) => !t.hit);
  const peakX = p.peakPriceSol / e;
  const hiX = next ? next.multiple : Math.max(peakX, m) * 1.1;
  const trailX = p.targets.trailingStopPrice ? p.targets.trailingStopPrice / e : null;
  const lo = Math.min(stopX, m) * 0.98;
  const hi = Math.max(hiX, m) * 1.01;
  const at = (x: number) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo || 1)) * 100))}%`;
  const up = m >= 1;
  return (
    <div className="mt-3">
      <div className="relative h-1.5 rounded-full bg-surface-3" aria-hidden="true">
        <div className={`absolute inset-y-0 rounded-full transition-[left,right] duration-400 ${up ? 'bg-good/70' : 'bg-critical/60'}`} style={{ left: up ? at(1) : at(m), right: `calc(100% - ${up ? at(m) : at(1)})` }} />
        <span className="absolute -top-[3px] h-3 w-0.5 rounded bg-ink-2" style={{ left: at(1) }} title="entry" />
        {trailX && <span className="absolute -top-[3px] h-3 w-0.5 rounded bg-warning" style={{ left: at(trailX) }} title="trailing stop" />}
        <span className={`absolute -top-[5px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-surface shadow transition-[left] duration-400 ${up ? 'bg-good' : 'bg-critical'}`} style={{ left: at(m) }} />
      </div>
      <div className="mt-1.5 flex justify-between gap-2 text-xs text-muted">
        <span className="tabular">stop {multiple(stopX)}{trailX ? ` · trail ${multiple(trailX)}` : ''}</span>
        <span className="tabular truncate text-right">{next ? `next: sell ${next.sellPct}% at ${next.multiple}×` : 'all targets hit — trailing'}</span>
      </div>
    </div>
  );
}

export function PositionRow({ p, onSold }: { p: LivePosition; onSold: () => void }) {
  const [open, setOpen] = useState(false);
  const m = p.multiple;
  const fresh = p.live && Date.now() - p.live.at < 6_000;
  const left = (p.sizeSol * p.remainingPct) / 100;
  const edge = m === null ? 'border-l-line-strong' : m >= 1 ? 'border-l-good' : 'border-l-critical';
  const risk = p.live?.risk;
  return (
    <li className={`card card-lift min-w-0 overflow-hidden border-l-[3px] ${edge}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="block w-full p-4 text-left transition-colors hover:bg-surface-2/40 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-base font-semibold text-ink">{p.symbol}</span>
              <Badge>{STRATEGY_LABEL[p.strategy] ?? p.strategy}</Badge>
              {p.learning && <Badge tone="accent">learning</Badge>}
              {fresh && (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-up">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" />
                  live
                </span>
              )}
            </div>
            <div className="tabular mt-1.5 truncate text-sm text-ink-2">
              {p.mcEntryUsd !== null ? usd(p.mcEntryUsd) : mcSol(p.entryMarketCapSol)} → <span className="font-medium text-ink">{p.mcNowUsd !== null ? usd(p.mcNowUsd) : mcSol(p.mcNowSol)}</span>{' '}
              <McChange value={p.mcChangePct} className="text-xs" />
            </div>
            <div className="tabular mt-0.5 truncate text-xs text-muted">
              {sol(left, 3)} in · {pct(p.remainingPct, 0)} left · {ago(p.openedAt)}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`tabular text-[26px] font-bold leading-none tracking-tight ${m === null ? 'text-ink-2' : m >= 1 ? 'text-up' : 'text-down'}`}>{multiple(m)}</div>
            <div className="mt-1.5 text-sm">
              <Pnl value={p.unrealizedPnlSol} />
            </div>
            {p.realizedPnlSol !== 0 && (
              <div className="text-xs text-muted">
                banked <Pnl value={p.realizedPnlSol} className="text-xs" />
              </div>
            )}
          </div>
        </div>
        <RangeBar p={p} />
        <div className="mt-2 flex items-center justify-center gap-1 text-xs text-muted" aria-hidden="true">
          <Icon name="chevron" size={12} className={`transition-transform duration-250 ${open ? '-rotate-90' : 'rotate-90'}`} />
          {open ? 'less' : 'chart & details'}
        </div>
      </button>

      {open && (
        <div className="fade-in border-t border-line p-4 sm:p-5">
          <McCompare p={p} />
          <div className="mt-3">
            <PositionChart position={p} height={170} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Field label="Entry price">{price(p.entryPriceSol)}</Field>
            <Field label="Current price">{price(p.currentPriceSol)}</Field>
            <Field label="Peak">{multiple(p.peakPriceSol / p.entryPriceSol)}</Field>
            <Field label="Exit risk">
              {risk === undefined ? '—' : <span className={risk >= 0.6 ? 'text-down' : risk >= 0.35 ? 'text-warning' : 'text-up'}>{risk >= 0.6 ? 'High' : risk >= 0.35 ? 'Rising' : 'Low'} ({Math.round(risk * 100)})</span>}
            </Field>
          </dl>
          <div className="mt-4 text-sm">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Exit plan</div>
            <ul className="flex flex-wrap gap-2 text-ink-2">
              <li className="rounded-lg bg-surface-2 px-2 py-1 text-xs">Stop {price(p.targets.stopLossPrice)}</li>
              {p.targets.takeProfits.map((t) => (
                <li key={t.multiple} className={`rounded-lg px-2 py-1 text-xs ${t.hit ? 'bg-good/12 text-up' : 'bg-surface-2'}`}>
                  {t.hit ? '✓' : '○'} {t.sellPct}% at {t.multiple}×
                </li>
              ))}
              <li className="rounded-lg bg-surface-2 px-2 py-1 text-xs">{p.targets.trailingStopPrice !== null ? `Trailing stop ${price(p.targets.trailingStopPrice)}` : 'Trailing stop not active yet'}</li>
            </ul>
          </div>
          {p.live && (
            <p className="mt-3 text-sm text-ink-2">
              You hold <span className="tabular text-ink">{p.live.ownSupplyPct.toFixed(2)}%</span> of the supply · selling it all now moves the price{' '}
              <span className={`tabular ${p.live.exitImpactPct > 5 ? 'text-down' : 'text-ink'}`}>−{p.live.exitImpactPct.toFixed(1)}%</span>
            </p>
          )}
          {p.health && (
            <p className="mt-1 text-sm text-ink-2">
              {num(p.health.holders)} holders · dev {pct(p.health.devHoldingPct)} · top 10 {pct(p.health.top10HolderPct)}
              {p.health.curvePct < 100 ? ` · curve ${pct(p.health.curvePct)}` : ''}
            </p>
          )}
          {p.buyReason && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-ink-2 hover:text-ink">Why it bought</summary>
              <p className="mt-2 rounded-xl bg-surface-2/60 p-3 leading-relaxed text-ink">{p.buyReason}</p>
            </details>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="danger" onClick={() => window.confirm(`Sell all of ${p.symbol} now?`) && void api(`/api/positions/${p.id}/sell`, { method: 'POST' }).then(onSold)}>
              Sell now
            </Button>
            <Link to={`/token/${p.mint}`} className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-accent-text hover:underline">
              Coin details →
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs font-medium text-muted">{label}</dt>
      <dd className="tabular mt-0.5 break-words text-ink">{children}</dd>
    </div>
  );
}
