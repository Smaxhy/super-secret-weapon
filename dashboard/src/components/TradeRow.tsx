/** One completed trade in the history table. */
import { Link } from 'react-router-dom';
import { duration, EXIT_LABEL, pct, price, sol, STRATEGY_LABEL } from '../lib/format';
import type { TradeRowData } from '../lib/types';
import { Pnl } from './ui';

export function TradeRow({ t }: { t: TradeRowData }) {
  return (
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
      <td className="pr-4 text-ink-2">{duration(t.holdSeconds)}</td>
      <td className="pr-4 text-ink-2">{t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'}</td>
      <td className="pr-2 text-ink-2">{t.scoreAtEntry?.toFixed(0) ?? '—'}</td>
    </tr>
  );
}
