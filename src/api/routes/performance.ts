/** GET /api/performance — P&L curve, daily returns, win rates, drawdown. GET /api/overview — headline numbers. */
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { getConfig } from '../../config/runtime-config';
import { realisedPnlToday } from '../../executor/trader';
import { prisma } from '../../lib/prisma';
import { summarise, type ClosedTrade } from '../performance-calc';
import type { ApiDeps } from '../deps';

async function closedTrades(mode: 'PAPER' | 'LIVE'): Promise<ClosedTrade[]> {
  const rows = await prisma.position.findMany({ where: { status: 'CLOSED', mode }, include: { token: { select: { symbol: true } } } });
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
  app.get('/api/lab', async () => {
    if (!deps.lab) return { enabled: false, variants: [], applied: null, open: 0, autoApply: false, minTrades: 0 };
    return { enabled: true, ...(await deps.lab.report()) };
  });

  app.get('/api/performance', async () => {
    const mode = deps.executor.mode;
    const start = getConfig().paper.startingBalanceSol;
    return { mode, startingBalanceSol: start, ...summarise(await closedTrades(mode), start) };
  });

  app.get('/api/overview', async () => {
    const cfg = getConfig();
    const mode = deps.executor.mode;
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [balance, open, closed, todayPnl, launchesToday] = await Promise.all([
      deps.executor.getBalanceSol(),
      prisma.position.count({ where: { status: 'OPEN', mode } }),
      closedTrades(mode),
      realisedPnlToday(mode),
      prisma.token.count({ where: { createdAt: { gte: dayStart } } }),
    ]);
    const s = summarise(closed, cfg.paper.startingBalanceSol);
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
      openPositions: open,
      maxPositions: cfg.trading.maxConcurrentPositions,
      totalPnlSol: s.totalPnlSol,
      todayPnlSol: todayPnl,
      trades: s.trades,
      winRate: s.winRate,
      launchesToday,
      cumulative: s.cumulative,
    };
  });
}
