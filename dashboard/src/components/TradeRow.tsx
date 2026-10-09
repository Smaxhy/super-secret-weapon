/** One completed trade in the history table. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { duration, EXIT_LABEL, pct, price, sol, STRATEGY_LABEL } from '../lib/format';
import type { TradeRowData } from '../lib/types';
import { Pnl } from './ui';

export function TradeRow({ t }: { t: TradeRowData }) {
  const [open, setOpen] = useState(false);
  const hasWhy = !!t.buyReason || t.sellReasons.length > 0;
  return (
    <>
    <tr className="border-t border-line hover:bg-surface-2">
      <td className="py-2.5 pr-4">
        <Link to={`/token/${t.mint}`} className="font-semibold text-ink underline-offset-2 hover:underline">
          {t.symbol}
        </Link>
        <div className="text-xs text-muted">{t.closedAt ? new Date(t.closedAt).toLocaleString() : ''}</div>
      </td>
      <td className="pr-4 text-ink-2">{STRATEGY_LABEL[t.strategy] ?? t.strategy}</td>
      <td className="pr-4 text-ink-2">{sol(t.sizeSol, 2)}</td>
      <td className="pr-4 text-ink-2">{price(t.entryPriceSol)}</td>
      <td className="pr-4 text-ink-2">{price(t.exitPriceSol)}</td>
      <td className="pr-4">
        <Pnl value={t.pnlSol} />
        <div className={`text-xs ${t.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(t.pnlPct, 1, true)}</div>
      </td>
      <td className="pr-4">
        <span className={t.peakMultiple >= 1 ? 'text-up' : 'text-ink-2'}>{pct((t.peakMultiple - 1) * 100, 0, true)}</span>
        <div className="text-xs text-muted">
          peak {t.peakMultiple.toFixed(2)}×{t.bestWithin1hMultiple && t.bestWithin1hMultiple > t.peakMultiple * 1.05 ? ` · later ${t.bestWithin1hMultiple.toFixed(1)}×` : ''}
        </div>
      </td>
      <td className="pr-4 text-ink-2">{duration(t.holdSeconds)}</td>
      <td className="pr-4 text-ink-2">{t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'}</td>
      <td className="pr-2 text-ink-2">{t.scoreAtEntry?.toFixed(0) ?? '—'}</td>
      <td className="pr-2">
        {hasWhy && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-surface-2">
            {open ? 'Hide' : 'Why?'}
          </button>
        )}
      </td>
    </tr>
    {open && (
      <tr className="bg-surface-2">
        <td colSpan={11} className="px-3 py-3 text-sm leading-relaxed text-ink">
          {t.buyReason && (
            <p>
              <strong>Why it bought:</strong> {t.buyReason}
            </p>
          )}
          {t.sellReasons.map((r, i) => (
            <p key={i} className="mt-1">
              <strong>Sell {i + 1}:</strong> {r}
            </p>
          ))}
          {t.lesson && (
            <p className="mt-1 text-accent">
              <strong>Lesson:</strong> {t.lesson.lesson}
            </p>
          )}
        </td>
      </tr>
    )}
    </>
  );
}

/** Phone version of a completed trade: a compact card with an expandable "why". */
export function TradeCard({ t }: { t: TradeRowData }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/token/${t.mint}`} className="block truncate font-semibold text-ink">
            {t.symbol}
          </Link>
          <div className="truncate text-xs text-muted">
            {STRATEGY_LABEL[t.strategy] ?? t.strategy} · {t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'} · {duration(t.holdSeconds)}
          </div>
        </div>
        <div className="shrink-0 whitespace-nowrap text-right">
          <Pnl value={t.pnlSol} />
          <div className={`text-xs ${t.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(t.pnlPct, 1, true)}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-2">
        <span className="tabular min-w-0">
          {sol(t.sizeSol, 2)} · peak {t.peakMultiple.toFixed(2)}× · score {t.scoreAtEntry?.toFixed(0) ?? '—'}
        </span>
        {(t.buyReason || t.sellReasons.length > 0) && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="shrink-0 rounded-md border border-line px-2 py-1 text-ink">
            {open ? 'Hide' : 'Why?'}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-1 text-sm leading-relaxed text-ink">
          {t.buyReason && (
            <p>
              <strong>Bought:</strong> {t.buyReason}
            </p>
          )}
          {t.sellReasons.map((r, i) => (
            <p key={i}>
              <strong>Sell {i + 1}:</strong> {r}
            </p>
          ))}
          {t.lesson && (
            <p className="text-accent">
              <strong>Lesson:</strong> {t.lesson.lesson}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
