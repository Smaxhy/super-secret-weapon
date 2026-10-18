/** One completed trade: the details panel (drawer) and the phone list row. */
import { Link } from 'react-router-dom';
import { duration, EXIT_LABEL, multiple, pct, price, sol, STRATEGY_LABEL } from '../lib/format';
import type { TradeRowData } from '../lib/types';
import { PnlChip } from './PositionRow';
import { Badge, Pnl, SectionLabel } from './ui';

export function TradeWhy({ t }: { t: TradeRowData }) {
  if (!t.buyReason && !t.sellReasons.length && !t.lesson) return <p className="text-sm text-muted">No explanation stored for this trade.</p>;
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink">
      {t.buyReason && (
        <div>
          <SectionLabel>Why it bought</SectionLabel>
          <p className="rounded-xl bg-surface-2/60 p-3">{t.buyReason}</p>
        </div>
      )}
      {t.sellReasons.length > 0 && (
        <div>
          <SectionLabel>Why it sold</SectionLabel>
          <ol className="space-y-2">
            {t.sellReasons.map((r, i) => (
              <li key={i} className="flex gap-2.5 rounded-xl bg-surface-2/60 p-3">
                <span className="tabular shrink-0 text-xs font-semibold text-muted">{i + 1}</span>
                <span className="min-w-0 break-words">{r}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {t.lesson && (
        <div>
          <SectionLabel>Coach's lesson</SectionLabel>
          <p className="rounded-xl bg-accent/10 p-3 text-accent-text">{t.lesson.lesson}</p>
        </div>
      )}
    </div>
  );
}

export function TradeDetails({ t }: { t: TradeRowData }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-3">
        <Big label="Result" value={<Pnl value={t.pnlSol} dp={2} />} />
        <Big label="Return" value={<span className={t.pnlPct >= 0 ? 'text-up' : 'text-down'}>{pct(t.pnlPct, 1, true)}</span>} />
        <Big label="Peak" value={<span className={t.peakMultiple >= 1 ? 'text-up' : 'text-ink-2'}>{multiple(t.peakMultiple)}</span>} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Fact label="Strategy">{STRATEGY_LABEL[t.strategy] ?? t.strategy}</Fact>
        <Fact label="How it ended">{t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'}</Fact>
        <Fact label="Size">{sol(t.sizeSol, 3)}</Fact>
        <Fact label="Held">{duration(t.holdSeconds)}</Fact>
        <Fact label="Entry price">{price(t.entryPriceSol)}</Fact>
        <Fact label="Exit price">{price(t.exitPriceSol)}</Fact>
        <Fact label="Most it was up">{sol(t.maxProfitSol, 3)}</Fact>
        <Fact label="Best within 1 h">{t.bestWithin1hMultiple ? multiple(t.bestWithin1hMultiple) : '—'}</Fact>
        <Fact label="Score at entry">{t.scoreAtEntry?.toFixed(0) ?? '—'}</Fact>
        <Fact label="Closed">{t.closedAt ? new Date(t.closedAt).toLocaleString() : '—'}</Fact>
      </dl>
      <TradeWhy t={t} />
      <Link to={`/token/${t.mint}`} className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline">
        Coin details
      </Link>
    </div>
  );
}

/** Phone list row: symbol, strategy, exit + hold, P&L chip. Tap → details sheet. */
export function TradeListRow({ t, onOpen }: { t: TradeRowData; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-2/60">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold text-ink">{t.symbol}</span>
            <Badge>{STRATEGY_LABEL[t.strategy] ?? t.strategy}</Badge>
          </div>
          <div className="tabular mt-0.5 truncate text-xs text-muted">
            {t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'} · {duration(t.holdSeconds)} · {t.closedAt ? new Date(t.closedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <Pnl value={t.pnlSol} className="text-sm" />
          <div className="mt-0.5">
            <PnlChip value={t.pnlPct} />
          </div>
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
