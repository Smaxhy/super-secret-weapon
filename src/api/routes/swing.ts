/**
 * Swing trading bigger coins (v7).
 *   GET    /api/swing                  the coins followed for swings (bounce-back power, last decision),
 *                                      your watchlist, stats, pool self-check, history feed health
 *   POST   /api/swing/watchlist        { mint } — add a coin (its contract address) to your watchlist
 *   DELETE /api/swing/watchlist/:mint  remove it
 */
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG } from '../../config/default';
import { getConfig, updateConfigSection } from '../../config/runtime-config';
import { recordEvent } from '../../lib/bot-events';
import { isValidPubkey } from '../../lib/pumpfun';
import type { ApiDeps } from '../deps';

export async function swingRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const cfg = () => getConfig().swing ?? DEFAULT_CONFIG.swing;

  app.get('/api/swing', async () => {
    const c = cfg();
    const snap = deps.swing?.universe.snapshot(60) ?? null;
    return {
      enabled: c.enabled && getConfig().trading.enabledStrategies.SWING,
      watchlist: c.watchlist ?? [],
      maxWatchlist: c.maxWatchlist,
      rules: { minMarketCapUsd: c.minMarketCapUsd, maxMarketCapUsd: c.maxMarketCapUsd, minLiquidityUsd: c.minLiquidityUsd, minVolume24hUsd: c.minVolume24hUsd, minAgeMin: c.minAgeMin, minScore: c.minScore, maxCoins: c.maxCoins },
      coins: snap?.coins ?? [],
      universe: snap?.stats ?? null,
      trader: deps.swing?.trader.stats ?? null,
      pda: snap?.pda ?? null,
      history: snap?.history ?? null,
    };
  });

  app.post<{ Body: { mint?: string } }>('/api/swing/watchlist', async (req, reply) => {
    const mint = String(req.body?.mint ?? '').trim();
    if (mint.length < 32 || mint.length > 44 || !isValidPubkey(mint)) return reply.code(400).send({ error: 'Paste the coin\'s contract (mint) address — not the ticker.' });
    const c = cfg();
    const list = [...new Set([...(c.watchlist ?? []), mint])];
    if (list.length > c.maxWatchlist) return reply.code(400).send({ error: `The watchlist holds at most ${c.maxWatchlist} coins.` });
    await updateConfigSection('swing', { watchlist: list });
    void recordEvent({ module: 'swing', type: 'watchlist_add', mint, message: `Added to the swing watchlist` });
    void deps.swing?.universe.refresh().catch(() => undefined);
    return { watchlist: list };
  });

  app.delete<{ Params: { mint: string } }>('/api/swing/watchlist/:mint', async (req) => {
    const list = (cfg().watchlist ?? []).filter((m) => m !== req.params.mint);
    await updateConfigSection('swing', { watchlist: list });
    return { watchlist: list };
  });
}
