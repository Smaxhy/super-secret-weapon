/**
 * Tracked wallets (copy trading).
 *   GET    /api/wallets                list with copy-trade results per wallet
 *   POST   /api/wallets                { address, label? } add
 *   PATCH  /api/wallets/:address       { label?, active? } edit / pause
 *   DELETE /api/wallets/:address       remove
 */
import type { FastifyInstance } from 'fastify';
import { recordEvent } from '../../lib/bot-events';
import { prisma } from '../../lib/prisma';
import { isValidPubkey } from '../../lib/pumpfun';

export async function walletsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/wallets', async () => {
    const [wallets, copies] = await Promise.all([
      prisma.trackedWallet.findMany({ orderBy: { addedAt: 'desc' } }),
      prisma.position.findMany({ where: { strategy: 'SMART_MONEY_COPY' }, select: { status: true, realizedPnlSol: true, entryContext: true } }),
    ]);
    return wallets.map((w) => {
      const mine = copies.filter((c) => (c.entryContext as { copiedWallet?: string } | null)?.copiedWallet === w.address);
      const closed = mine.filter((c) => c.status === 'CLOSED');
      return {
        address: w.address,
        label: w.label,
        active: w.active,
        addedAt: w.addedAt,
        lastSeenAt: w.lastSeenAt,
        tradesSeen: w.tradeCount,
        copies: mine.length,
        openCopies: mine.length - closed.length,
        copyPnlSol: closed.reduce((s, c) => s + c.realizedPnlSol, 0),
        copyWinRate: closed.length ? (closed.filter((c) => c.realizedPnlSol > 0).length / closed.length) * 100 : null,
      };
    });
  });

  app.post<{ Body: { address?: string; label?: string } }>('/api/wallets', async (req, reply) => {
    const address = String(req.body?.address ?? '').trim();
    const label = String(req.body?.label ?? '').trim().slice(0, 40) || null;
    if (!isValidPubkey(address)) return reply.code(400).send({ error: 'That is not a valid Solana wallet address' });
    const w = await prisma.trackedWallet.upsert({ where: { address }, update: { label, active: true }, create: { address, label, source: 'MANUAL' } });
    void recordEvent({ module: 'api', type: 'wallet_added', message: `Tracking wallet ${label ?? address}`, data: { address } });
    return w;
  });

  app.patch<{ Params: { address: string }; Body: { label?: string; active?: boolean } }>('/api/wallets/:address', async (req, reply) => {
    const data: { label?: string | null; active?: boolean } = {};
    if (typeof req.body?.label === 'string') data.label = req.body.label.trim().slice(0, 40) || null;
    if (typeof req.body?.active === 'boolean') data.active = req.body.active;
    const w = await prisma.trackedWallet.update({ where: { address: req.params.address }, data }).catch(() => null);
    return w ?? reply.code(404).send({ error: 'Unknown wallet' });
  });

  app.delete<{ Params: { address: string } }>('/api/wallets/:address', async (req) => {
    await prisma.trackedWallet.delete({ where: { address: req.params.address } }).catch(() => undefined);
    return { ok: true };
  });
}
