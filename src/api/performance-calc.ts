/**
 * Performance maths for the dashboard — pure functions over closed positions,
 * so they're easy to test and identical for paper and live.
 */
export interface ClosedTrade {
  id: string;
  mint: string;
  symbol: string;
  strategy: string;
  sizeSol: number;
  pnlSol: number;
  openedAt: Date;
  closedAt: Date;
  exitReason: string | null;
}

export interface PerformanceSummary {
  totalPnlSol: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWinSol: number | null;
  avgLossSol: number | null;
  /** Largest peak-to-trough fall of cumulative P&L, in SOL. */
  maxDrawdownSol: number;
  /** Same, as % of (starting balance + peak P&L). */
  maxDrawdownPct: number;
  /** mean(daily P&L) / stdev(daily P&L) — higher = steadier profits. null with < 2 days. */
  consistency: number | null;
  best: ClosedTrade | null;
  worst: ClosedTrade | null;
  cumulative: Array<{ t: string; pnl: number; symbol: string }>;
  daily: Array<{ day: string; pnl: number; trades: number }>;
  byStrategy: Array<{ strategy: string; trades: number; winRate: number | null; pnlSol: number }>;
  byExitReason: Array<{ reason: string; trades: number; pnlSol: number }>;
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function summarise(trades: ClosedTrade[], startingBalanceSol: number): PerformanceSummary {
  const sorted = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  const wins = sorted.filter((t) => t.pnlSol > 0);
  const losses = sorted.filter((t) => t.pnlSol <= 0);

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;
  const cumulative = sorted.map((t) => {
    cum += t.pnlSol;
    peak = Math.max(peak, cum);
    const dd = peak - cum;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = (dd / (startingBalanceSol + peak)) * 100;
    }
    return { t: t.closedAt.toISOString(), pnl: r4(cum), symbol: t.symbol };
  });

  const dailyMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of sorted) {
    const day = t.closedAt.toISOString().slice(0, 10);
    const d = dailyMap.get(day) ?? { pnl: 0, trades: 0 };
    d.pnl += t.pnlSol;
    d.trades++;
    dailyMap.set(day, d);
  }
  const daily = [...dailyMap.entries()].map(([day, d]) => ({ day, pnl: r4(d.pnl), trades: d.trades }));

  let consistency: number | null = null;
  if (daily.length >= 2) {
    const mean = daily.reduce((s, d) => s + d.pnl, 0) / daily.length;
    const sd = Math.sqrt(daily.reduce((s, d) => s + (d.pnl - mean) ** 2, 0) / (daily.length - 1));
    consistency = sd > 0 ? Math.round((mean / sd) * 100) / 100 : null;
  }

  const group = <K extends string>(key: (t: ClosedTrade) => K) => {
    const m = new Map<K, ClosedTrade[]>();
    for (const t of sorted) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return m;
  };

  const byStrategy = [...group((t) => t.strategy).entries()].map(([strategy, ts]) => ({
    strategy,
    trades: ts.length,
    winRate: ts.length ? (ts.filter((t) => t.pnlSol > 0).length / ts.length) * 100 : null,
    pnlSol: r4(ts.reduce((s, t) => s + t.pnlSol, 0)),
  }));
  const byExitReason = [...group((t) => t.exitReason ?? 'OPEN').entries()]
    .map(([reason, ts]) => ({ reason, trades: ts.length, pnlSol: r4(ts.reduce((s, t) => s + t.pnlSol, 0)) }))
    .sort((a, b) => b.trades - a.trades);

  const byPnl = [...sorted].sort((a, b) => b.pnlSol - a.pnlSol);
  return {
    totalPnlSol: r4(cum),
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRate: sorted.length ? (wins.length / sorted.length) * 100 : null,
    avgWinSol: wins.length ? r4(wins.reduce((s, t) => s + t.pnlSol, 0) / wins.length) : null,
    avgLossSol: losses.length ? r4(losses.reduce((s, t) => s + t.pnlSol, 0) / losses.length) : null,
    maxDrawdownSol: r4(maxDd),
    maxDrawdownPct: Math.round(maxDdPct * 100) / 100,
    consistency,
    best: byPnl[0] ?? null,
    worst: byPnl[byPnl.length - 1] ?? null,
    cumulative,
    daily,
    byStrategy,
    byExitReason,
  };
}
