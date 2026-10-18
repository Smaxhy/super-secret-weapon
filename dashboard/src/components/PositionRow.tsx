/**
 * Open-trade building blocks shared by Positions and Overview:
 *  - RangeBar: where the price sits between the stop (left) and the next take-profit (right), entry marked.
 *  - PnlChip: signed % in a tinted pill (sign in the text, so colour is never the only cue).
 *  - PositionDetails: everything about one trade (MC in → now, live chart, numbers, exit plan, why it bought,
 *    Sell) — shown in the right-hand drawer on desktop and a bottom sheet on phones.
 *  - PositionCard: the phone card for one open trade.
 */
import { Link } from 'react-router-dom';
import type { LivePosition } from '../hooks/useLivePositions';
import { api } from '../lib/api';
import { ago, mcSol, multiple, num, pct, price, sol, STRATEGY_LABEL, usd } from '../lib/format';
import { McChange, McCompare } from './McCompare';
import { PositionChart } from './PositionChart';
import { Badge, Button, Pnl, SectionLabel } from './ui';

export function RangeBar({ p, compact = false }: { p: LivePosition; compact?: boolean }) {
  const e = p.entryPriceSol;
  const m = p.multiple;
  if (!(e > 0) || m === null) return <div className="h-1.5 rounded-full bg-surface-3" aria-hidden="true" />;
  const stopX = p.targets.stopLossPrice > 0 ? p.targets.stopLossPrice / e : 0.85;
  const next = p.targets.takeProfits.find((t) => !t.hit);
  const peakX = p.peakPriceSol / e;
  const hiX = next ? next.multiple : Math.max(peakX, m) * 1.1;
  const trailX = p.targets.trailingStopPrice ? p.targets.trailingStopPrice / e : null;
  const lo = Math.min(stopX, m) * 0.98;
  const hi = Math.max(hiX, m) * 1.01;
  const at = (x: number) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo || 1)) * 100))}%`;
  const up = m >= 1;
  const label = `stop ${multiple(stopX)}${trailX ? `, trail ${multiple(trailX)}` : ''}, now ${multiple(m)}, ${next ? `next sell ${next.sellPct}% at ${next.multiple}×` : 'all targets hit'}`;
  return (
    <div title={label}>
      <div className={`relative rounded-full bg-surface-3 ${compact ? 'h-1' : 'h-1.5'}`} role="img" aria-label={label}>
        <div className={`absolute inset-y-0 rounded-full transition-[left,right] duration-400 ${up ? 'bg-good/70' : 'bg-critical/60'}`} style={{ left: up ? at(1) : at(m), right: `calc(100% - ${up ? at(m) : at(1)})` }} />
        <span className="absolute -top-[3px] h-3 w-0.5 rounded bg-ink-2" style={{ left: at(1) }} />
        {trailX && <span className="absolute -top-[3px] h-3 w-0.5 rounded bg-warning" style={{ left: at(trailX) }} />}
        <span className={`absolute -translate-x-1/2 rounded-full border-2 border-surface shadow transition-[left] duration-400 ${up ? 'bg-good' : 'bg-critical'} ${compact ? '-top-[4px] h-3 w-3' : '-top-[5px] h-4 w-4'}`} style={{ left: at(m) }} />
      </div>
      {!compact && (
        <div className="mt-1.5 flex justify-between gap-2 text-xs text-muted">
          <span className="tabular">stop {multiple(stopX)}{trailX ? ` · trail ${multiple(trailX)}` : ''}</span>
          <span className="tabular truncate text-right">{next ? `next ${next.sellPct}% at ${next.multiple}×` : 'trailing'}</span>
        </div>
      )}
    </div>
  );
}

export function PnlChip({ value, className = '' }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={`text-xs text-muted ${className}`}>—</span>;
  const cls = value > 0 ? 'bg-good/12 text-up' : value < 0 ? 'bg-critical/12 text-down' : 'bg-surface-2 text-ink-2';
  return <span className={`tabular inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-semibold ${cls} ${className}`}>{pct(value, 1, true)}</span>;
}

/** % change of a position since the buy (from the live multiple). */
export const posPct = (p: LivePosition) => (p.multiple === null ? null : (p.multiple - 1) * 100);
export const isFresh = (p: LivePosition) => !!p.live && Date.now() - p.live.at < 6_000;
export const mcIn = (p: LivePosition) => (p.mcEntryUsd !== null ? usd(p.mcEntryUsd) : mcSol(p.entryMarketCapSol));
export const mcNow = (p: LivePosition) => (p.mcNowUsd !== null ? usd(p.mcNowUsd) : mcSol(p.mcNowSol));

export function LiveDot() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-up">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" />
      live
    </span>
  );
}

export function sellPosition(p: LivePosition, onSold: () => void) {
  if (window.confirm(`Sell all of ${p.symbol} now?`)) void api(`/api/positions/${p.id}/sell`, { method: 'POST' }).then(onSold);
}

export function PositionDetails({ p, onSold }: { p: LivePosition; onSold: () => void }) {
  const risk = p.live?.risk;
  const left = (p.sizeSol * p.remainingPct) / 100;
  return (
    <div className="flex flex-col gap-5 text-sm">
      <div className="grid grid-cols-3 gap-3">
        <Big label="Now" value={<span className={p.multiple === null ? 'text-ink-2' : p.multiple >= 1 ? 'text-up' : 'text-down'}>{multiple(p.multiple)}</span>} />
        <Big label="Unrealised" value={<Pnl value={p.unrealizedPnlSol} dp={2} />} />
        <Big label="Banked" value={<Pnl value={p.realizedPnlSol} dp={2} />} />
      </div>
      <McCompare p={p} />
      <div>
        <SectionLabel>Price since the buy</SectionLabel>
        <PositionChart position={p} height={200} />
      </div>
      <div>
        <SectionLabel>Where it sits</SectionLabel>
        <RangeBar p={p} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label="In the trade">{sol(left, 3)} · {pct(p.remainingPct, 0)} left</Fact>
        <Fact label="Opened">{ago(p.openedAt)}</Fact>
        <Fact label="Entry price">{price(p.entryPriceSol)}</Fact>
        <Fact label="Current price">{price(p.currentPriceSol)}</Fact>
        <Fact label="Peak">{multiple(p.peakPriceSol / p.entryPriceSol)}</Fact>
        <Fact label="Score at entry">{p.scoreAtEntry !== null ? Math.round(p.scoreAtEntry) : '—'}</Fact>
        <Fact label="Exit risk">
          {risk === undefined ? '—' : <span className={risk >= 0.6 ? 'text-down' : risk >= 0.35 ? 'text-warning' : 'text-up'}>{risk >= 0.6 ? 'High' : risk >= 0.35 ? 'Rising' : 'Low'} ({Math.round(risk * 100)})</span>}
        </Fact>
        {p.live && (
          <Fact label="Your share">
            {p.live.ownSupplyPct.toFixed(2)}% · selling moves it <span className={p.live.exitImpactPct > 5 ? 'text-down' : ''}>−{p.live.exitImpactPct.toFixed(1)}%</span>
          </Fact>
        )}
        {p.health && <Fact label="Holders">{num(p.health.holders)}</Fact>}
        {p.health && <Fact label="Dev · top 10">{pct(p.health.devHoldingPct)} · {pct(p.health.top10HolderPct)}</Fact>}
      </dl>
      <div>
        <SectionLabel>Exit plan</SectionLabel>
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          <PlanRow label="Stop loss" value={price(p.targets.stopLossPrice)} />
          {p.targets.takeProfits.map((t) => (
            <PlanRow key={t.multiple} label={`Sell ${t.sellPct}% at ${t.multiple}×`} value={t.hit ? <span className="text-up">done</span> : <span className="text-muted">waiting</span>} />
          ))}
          <PlanRow label="Trailing stop" value={p.targets.trailingStopPrice !== null ? price(p.targets.trailingStopPrice) : <span className="text-muted">not active yet</span>} />
        </ul>
      </div>
      {p.buyReason && (
        <div>
          <SectionLabel>Why it bought</SectionLabel>
          <p className="rounded-xl bg-surface-2/60 p-3 leading-relaxed text-ink">{p.buyReason}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="danger" onClick={() => sellPosition(p, onSold)}>
          Sell now
        </Button>
        <Link to={`/token/${p.mint}`} className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-accent-text hover:underline">
          Coin details
        </Link>
      </div>
    </div>
  );
}

/** Phone card for one open trade: tap opens the details sheet. */
export function PositionCard({ p, onOpen }: { p: LivePosition; onOpen: () => void }) {
  const m = p.multiple;
  const edge = m === null ? 'border-l-line-strong' : m >= 1 ? 'border-l-good' : 'border-l-critical';
  return (
    <li className={`card min-w-0 overflow-hidden border-l-[3px] ${edge}`}>
      <button type="button" onClick={onOpen} className="block w-full p-3.5 text-left active:bg-surface-2/50">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-semibold text-ink">{p.symbol}</span>
              <Badge>{STRATEGY_LABEL[p.strategy] ?? p.strategy}</Badge>
              {p.learning && <Badge tone="accent">learning</Badge>}
              {isFresh(p) && <LiveDot />}
            </div>
            <div className="tabular mt-1 truncate text-xs text-ink-2">
              {mcIn(p)} <span aria-hidden="true">→</span> <span className="font-medium text-ink">{mcNow(p)}</span> <McChange value={p.mcChangePct} className="text-xs" />
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`tabular text-xl font-bold leading-none ${m === null ? 'text-ink-2' : m >= 1 ? 'text-up' : 'text-down'}`}>{multiple(m)}</div>
            <div className="mt-1 text-xs">
              <Pnl value={p.unrealizedPnlSol} />
            </div>
          </div>
        </div>
        <div className="mt-3">
          <RangeBar p={p} />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted">
          <span className="tabular">{sol((p.sizeSol * p.remainingPct) / 100, 3)} in · {ago(p.openedAt)}</span>
          <span className="font-medium text-accent-text">Details</span>
        </div>
      </button>
    </li>
  );
}

function Big({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="truncate text-xs font-medium text-muted">{label}</div>
      <div className="tabular mt-1 truncate text-base font-semibold leading-tight sm:text-lg">{value}</div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs font-medium text-muted">{label}</dt>
      <dd className="tabular mt-0.5 break-words text-ink">{children}</dd>
    </div>
  );
}

function PlanRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <li className="flex min-h-10 items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="text-ink-2">{label}</span>
      <span className="tabular text-right text-ink">{value}</span>
    </li>
  );
}
