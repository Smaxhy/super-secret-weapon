/**
 * v27.4 (owner: "a tab for each currency with the results for each, by time frame and NY time; Monte Carlo; don't flood
 * me with strategies that clearly don't work"). Display only, from the lab report rows (`markets`, `mc`, `sess`, `dead`).
 */
import { Badge } from './ui';

export interface McResult { n: number; pProfit: number; p5AvgR: number; p50AvgR: number; ddR95: number; streak95: number; kellyPct?: number }
export interface MarketCell { pair: string; inN: number; inAvgR: number; n: number; avgR: number; pf: number | null; winPct: number; mcP: number | null; mcP5: number | null; sess: Array<[number, number]> }
export interface CellRow { id: string; name: string; tf: string; verdict: 'edge' | 'maybe' | 'no'; markets?: MarketCell[]; mc?: McResult | null; sess?: Array<[number, number]>; dead?: boolean }

export const SESSIONS = ['Asia', 'London', 'NY open', 'NY pm'] as const;
const SESSION_HELP = 'New York time: Asia 18:00–03:00, London 03:00–08:00, NY open 08:00–12:00, NY afternoon 12:00–18:00';
/** same bar as the bot's `cellPass` (montecarlo.ts MARKET_EDGE) */
export const cellPass = (c: MarketCell | undefined | null) => !!c && c.n >= 30 && c.avgR >= 0.1 && (c.pf ?? 99) >= 1.3 && c.inN >= 20 && c.inAvgR > 0 && (c.mcP ?? 0) >= 0.95;
/** clearly doesn't work on this market: lost before and after the 70/30 line */
export const cellDead = (c: MarketCell) => c.inN >= 15 && c.n >= 15 && c.inAvgR < 0 && c.avgR < 0;
/** a drop of D R at r% risk a trade, as % of the account */
export const ddPctAt = (ddR: number, riskPct: number) => Math.round((1 - Math.pow(1 - riskPct / 100, ddR)) * 1000) / 10;

const signed = (x: number, dp = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-muted');

export function McBadge({ p }: { p: number | null | undefined }) {
  if (p === null || p === undefined) return null;
  return (
    <Badge tone={p >= 0.95 ? 'up' : p >= 0.8 ? 'warn' : 'neutral'} title="Monte Carlo: its unseen trades reshuffled 400 times — the share of reshuffles that still made money">
      MC {Math.round(p * 100)}%
    </Badge>
  );
}

export function SessionStrip({ sess }: { sess?: Array<[number, number]> }) {
  if (!sess?.length) return null;
  return (
    <div className="grid grid-cols-4 gap-1" title={SESSION_HELP}>
      {sess.map(([n, r], i) => (
        <div key={SESSIONS[i]} className="rounded-md bg-surface-2/60 px-1.5 py-1 text-center">
          <div className="text-[10px] text-muted">{SESSIONS[i]}</div>
          <div className={`tabular text-xs font-semibold ${n ? tone(r) : 'text-muted'}`}>{n ? `${signed(r)}R` : '—'}</div>
          <div className="text-[10px] text-muted">{n}</div>
        </div>
      ))}
    </div>
  );
}

/** Every strategy × chart on one market, best first; the ones that clearly don't work there are folded away. */
export function MarketResults({ rows, pair, label, showDead, onOpen }: { rows: CellRow[]; pair: string; label: string; showDead: boolean; onOpen: (id: string, tf: string) => void }) {
  const cells = rows
    .filter((x) => x.id !== 'random')
    .flatMap((x) => {
      const c = x.markets?.find((m) => m.pair === pair);
      return c ? [{ x, c }] : [];
    })
    .sort((a, b) => Number(cellPass(b.c)) - Number(cellPass(a.c)) || b.c.n * b.c.avgR - a.c.n * a.c.avgR);
  const dead = cells.filter((k) => cellDead(k.c));
  const shown = showDead ? cells : cells.filter((k) => !cellDead(k.c));
  const passing = cells.filter((k) => cellPass(k.c)).length;
  if (!cells.length) return <p className="px-4 pb-4 text-sm text-muted sm:px-5">No tested trades on {label} yet — the lab adds it at its next hourly run.</p>;
  return (
    <div>
      <p className="px-4 pb-2 text-xs text-muted sm:px-5">
        {passing ? `${passing} strateg${passing === 1 ? 'y has' : 'ies have'} an edge on ${label} on its own` : `Nothing has an edge on ${label} on its own yet`} (30+ unseen trades, +0.1R a trade, PF 1.3+, profitable before the line too, Monte Carlo 95%+). {dead.length && !showDead ? `${dead.length} that clearly don't work here are hidden.` : ''}
      </p>
      <ul className="divide-y divide-line border-t border-line">
        {shown.map(({ x, c }) => {
          const pass = cellPass(c);
          return (
            <li key={`${x.id}:${x.tf}`}>
              <button type="button" onClick={() => onOpen(x.id, x.tf)} className={`flex w-full flex-col gap-2 px-4 py-3 text-left hover:bg-surface-2/60 sm:px-5 ${cellDead(c) ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-ink">{x.name}</span>
                  <Badge tone="neutral">{x.tf}</Badge>
                  {pass && <Badge tone="up">Edge on {label}</Badge>}
                  {cellDead(c) && <Badge tone="neutral">Doesn't work here</Badge>}
                  <McBadge p={c.mcP} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    unseen <span className={`tabular font-semibold ${tone(c.avgR)}`}>{signed(c.avgR)}R</span>/trade · {c.n} trades · {c.winPct}% won · PF {c.pf ?? '∞'}
                  </span>
                  <span>
                    before the line <span className={`tabular ${tone(c.inAvgR)}`}>{signed(c.inAvgR)}R</span> ({c.inN})
                  </span>
                  {c.mcP5 !== null && <span title="Monte Carlo: 1 in 20 reshuffles did this badly or worse">bad luck {signed(c.mcP5)}R/trade</span>}
                </div>
                <SessionStrip sess={c.sess} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Monte Carlo block for a strategy's drawer. */
export function McBlock({ mc, riskPct }: { mc: McResult | null | undefined; riskPct: number }) {
  if (!mc) return <p className="text-xs text-muted">Monte Carlo: fewer than 5 unseen trades.</p>;
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="mb-2 text-xs font-semibold text-muted">Monte Carlo — its {mc.n} unseen trades reshuffled 400 times</div>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div><div className="text-xs text-muted">Still made money</div><div className={`tabular font-semibold ${mc.pProfit >= 0.95 ? 'text-up' : mc.pProfit >= 0.8 ? 'text-ink' : 'text-down'}`}>{Math.round(mc.pProfit * 100)}%</div></div>
        <div><div className="text-xs text-muted">Typical / bad luck</div><div className="tabular font-semibold"><span className={tone(mc.p50AvgR)}>{signed(mc.p50AvgR)}</span> / <span className={tone(mc.p5AvgR)}>{signed(mc.p5AvgR)}</span>R</div></div>
        <div><div className="text-xs text-muted">Worst drop in 100 trades</div><div className="tabular font-semibold">{mc.ddR95}R · {ddPctAt(mc.ddR95, riskPct)}% at {riskPct}%</div></div>
        <div><div className="text-xs text-muted">Longest losing run</div><div className="tabular font-semibold">{mc.streak95} in a row</div></div>
      </div>
      <p className="mt-2 text-xs text-muted">Worst drop and losing run are the 1-in-20 bad case, not the average.</p>
      {mc.kellyPct !== undefined && (
        <p className={`mt-2 rounded-lg p-2 text-xs ${mc.kellyPct > 0 && riskPct > mc.kellyPct / 2 ? 'bg-warning/15 text-ink' : 'bg-surface-2/60 text-ink-2'}`}>
          {mc.kellyPct > 0 ? (
            <>
              Kelly sizing: its win rate and win / loss size say at most <b>{mc.kellyPct}%</b> a trade; traders use a quarter to half of that
              ({Math.round(mc.kellyPct * 25) / 100}–{Math.round(mc.kellyPct * 50) / 100}%) because the estimate is never exact.
              {riskPct > mc.kellyPct / 2 ? ` At ${riskPct}% you are past half-Kelly — bigger swings for no extra growth.` : ''}
            </>
          ) : (
            'Kelly sizing: 0% — on these trades there is no edge to size up.'
          )}
        </p>
      )}
    </div>
  );
}
