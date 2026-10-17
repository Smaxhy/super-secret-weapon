/** One completed trade in the history table. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { duration, EXIT_LABEL, pct, price, sol, STRATEGY_LABEL } from '../lib/format';
import type { TradeRowData } from '../lib/types';
import { Badge, Pnl } from './ui';

function Why({ t }: { t: TradeRowData }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-ink">
      {t.buyReason && (
        <p>
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted">Bought</span> {t.buyReason}
        </p>
      )}
      {t.sellReasons.map((r, i) => (
        <p key={i}>
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted">Sell {i + 1}</span> {r}
        </p>
      ))}
      {t.lesson && (
        <p className="rounded-lg bg-accent/10 px-3 py-2 text-accent-text">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide">Lesson</span> {t.lesson.lesson}
        </p>
      )}
    </div>
  );
}

export function TradeRow({ t }: { t: TradeRowData }) {
  const [open, setOpen] = useState(false);
  const hasWhy = !!t.buyReason || t.sellReasons.length > 0;
  return (
    <>
      <tr className="border-t border-line transition-colors hover:bg-surface-2/60">
        <td className="py-3 pr-4">
          <Link to={`/token/${t.mint}`} className="font-semibold text-ink underline-offset-2 hover:underline">
            {t.symbol}
          </Link>
          <div className="text-xs text-muted">{t.closedAt ? new Date(t.closedAt).toLocaleString() : ''}</div>
        </td>
        <td className="pr-4">
          <Badge>{STRATEGY_LABEL[t.strategy] ?? t.strategy}</Badge>
        </td>
        <td className="pr-4 text-right text-ink-2">{sol(t.sizeSol, 2)}</td>
        <td className="pr-4 text-right text-ink-2">{price(t.entryPriceSol)}</td>
        <td className="pr-4 text-right text-ink-2">{price(t.exitPriceSol)}</td>
        <td className="pr-4 text-right">
          <Pnl value={t.pnlSol} />
          <div className={`text-xs ${t.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(t.pnlPct, 1, true)}</div>
        </td>
        <td className="pr-4 text-right">
          <span className={t.peakMultiple >= 1 ? 'text-up' : 'text-ink-2'}>{pct((t.peakMultiple - 1) * 100, 0, true)}</span>
          <div className="text-xs text-muted">
            peak {t.peakMultiple.toFixed(2)}×{t.bestWithin1hMultiple && t.bestWithin1hMultiple > t.peakMultiple * 1.05 ? ` · later ${t.bestWithin1hMultiple.toFixed(1)}×` : ''}
          </div>
        </td>
        <td className="pr-4 text-right text-ink-2">{duration(t.holdSeconds)}</td>
        <td className="pr-4 text-ink-2">{t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'}</td>
        <td className="pr-2 text-right text-ink-2">{t.scoreAtEntry?.toFixed(0) ?? '—'}</td>
        <td className="pr-2">
          {hasWhy && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-h-8 rounded-lg border border-line-strong px-2.5 text-xs font-medium text-ink transition-colors hover:bg-surface-2">
              {open ? 'Hide' : 'Why?'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="fade-in bg-surface-2/50">
          <td colSpan={11} className="px-3 py-3">
            <Why t={t} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Phone version of a completed trade: a compact card with an expandable "why". */
export function TradeCard({ t }: { t: TradeRowData }) {
  const [open, setOpen] = useState(false);
  const up = t.pnlSol >= 0;
  return (
    <li className={`card min-w-0 border-l-[3px] p-3.5 ${up ? 'border-l-good' : 'border-l-critical'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/token/${t.mint}`} className="block truncate font-semibold text-ink">
            {t.symbol}
          </Link>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
            <Badge>{STRATEGY_LABEL[t.strategy] ?? t.strategy}</Badge>
            <span className="truncate">{t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'} · {duration(t.holdSeconds)}</span>
          </div>
        </div>
        <div className="shrink-0 whitespace-nowrap text-right">
          <Pnl value={t.pnlSol} />
          <div className={`text-xs ${t.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(t.pnlPct, 1, true)}</div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 text-xs text-ink-2">
        <span className="tabular min-w-0 truncate">
          {sol(t.sizeSol, 2)} · peak {t.peakMultiple.toFixed(2)}× · score {t.scoreAtEntry?.toFixed(0) ?? '—'}
        </span>
        {(t.buyReason || t.sellReasons.length > 0) && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-h-8 shrink-0 rounded-lg border border-line-strong px-2.5 text-ink transition-colors hover:bg-surface-2">
            {open ? 'Hide' : 'Why?'}
          </button>
        )}
      </div>
      {open && (
        <div className="fade-in mt-3 border-t border-line pt-3">
          <Why t={t} />
        </div>
      )}
    </li>
  );
}
