/** GET /api/performance — P&L curve, daily returns, win rates, drawdown. GET /api/overview — headline numbers. */
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { getConfig } from '../../config/runtime-config';
import { realisedPnlToday } from '../../executor/trader';
import { prisma } from '../../lib/prisma';
import { summarise, type ClosedTrade } from '../performance-calc';
import type { ApiDeps } from '../deps';

/** Fresh-stats marker (paper.statsSince): headline numbers only count trades closed after it. */
function statsSince(): Date | null {
  const iso = getConfig().paper.statsSince;
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function closedTrades(mode: 'PAPER' | 'LIVE'): Promise<ClosedTrade[]> {
  const since = mode === 'PAPER' ? statsSince() : null;
  const rows = await prisma.position.findMany({ where: { status: 'CLOSED', mode, ...(since ? { closedAt: { gte: since } } : {}) }, include: { token: { select: { symbol: true } } } });
  return rows.map((p) => ({
    id: p.id,
    mint: p.mint,
    symbol: p.token.symbol,
    strategy: p.strategy,
    sizeSol: p.sizeSol,
    pnlSol: p.realizedPnlSol,
    openedAt: p.openedAt,
    closedAt: p.closedAt ?? p.updatedAt,
    exitReason: p.exitReason,
  }));
}

export async function performanceRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  /**
   * Strategy lab: how each exit setup did on the same live signals (virtual trades, real
   * costs). BUY signals and near-misses are reported separately; `live` = the setup in use.
   */
  /** Chart strategies: each one's live record (virtual trades) vs random entries; `proven` = has a say in buys. */
  app.get('/api/ta-lab', async () => {
    if (!deps.taLab) return { enabled: false, strategies: [], baseline: null, open: 0 };
    return { enabled: true, ...(await deps.taLab.report()) };
  });

  app.get('/api/lab', async () => {
    if (!deps.lab) return { enabled: false, variants: [], applied: null, open: 0, autoApply: false, minTrades: 0 };
    return { enabled: true, ...(await deps.lab.report()) };
  });

  app.get('/api/performance', async () => {
    const mode = deps.executor.mode;
    const p = getConfig().paper;
    const start = p.startingBalanceSol;
    // Drawdown / % use everything put in (start + top-ups).
    return { mode, startingBalanceSol: start, addedSol: p.addedSol ?? 0, ...summarise(await closedTrades(mode), start + (p.addedSol ?? 0)) };
  });

  app.get<{ Querystring: { range?: string } }>('/api/overview', async (req) => {
    const cfg = getConfig();
    const mode = deps.executor.mode;
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [balance, open, closed, todayPnl, launchesToday] = await Promise.all([
      deps.executor.getBalanceSol(),
      prisma.position.count({ where: { status: 'OPEN', mode } }),
      closedTrades(mode),
      realisedPnlToday(mode, mode === 'PAPER' ? statsSince() : null),
      prisma.token.count({ where: { createdAt: { gte: dayStart } } }),
    ]);
    const s = summarise(closed, cfg.paper.startingBalanceSol + (cfg.paper.addedSol ?? 0));
    // Timeframe picker on the Overview (1 h / 6 h / 24 h / 7 d / all): numbers + curve for that window only.
    const RANGES: Record<string, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };
    const range = req.query.range && RANGES[req.query.range] ? req.query.range : 'all';
    const inWin = range === 'all' ? closed : closed.filter((t) => t.closedAt.getTime() >= Date.now() - RANGES[range]!);
    const w = range === 'all' ? s : summarise(inWin, cfg.paper.startingBalanceSol + (cfg.paper.addedSol ?? 0));
    const pcts = inWin.filter((t) => t.sizeSol > 0).map((t) => (t.pnlSol / t.sizeSol) * 100);
    const ls = deps.listenerStats();
    return {
      mode,
      configuredMode: env.TRADING_MODE,
      paused: cfg.state.paused,
      killSwitch: cfg.state.killSwitch,
      scannerConnected: ls?.connected ?? false,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      balanceSol: balance,
      startingBalanceSol: cfg.paper.startingBalanceSol,
      addedSol: cfg.paper.addedSol ?? 0,
      openPositions: open,
      maxPositions: cfg.trading.maxConcurrentPositions,
      totalPnlSol: s.totalPnlSol,
      todayPnlSol: todayPnl,
      trades: s.trades,
      winRate: s.winRate,
      launchesToday,
      cumulative: s.cumulative,
      range,
      window: {
        pnlSol: w.totalPnlSol,
        trades: w.trades,
        winRate: w.winRate,
        wins: inWin.filter((t) => t.pnlSol > 0).length,
        avgPct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null,
        bestPct: pcts.length ? Math.round(Math.max(...pcts) * 10) / 10 : null,
        worstPct: pcts.length ? Math.round(Math.min(...pcts) * 10) / 10 : null,
        cumulative: w.cumulative,
      },
    };
  });
}
