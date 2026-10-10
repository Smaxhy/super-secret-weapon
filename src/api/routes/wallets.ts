/**
 * Tracked wallets: COPY (copy its buys) and KOL (counts toward "KOLs buying").
 *   GET    /api/wallets                list with copy-trade results per wallet
 *   POST   /api/wallets                { address, label?, kind? } add
 *   POST   /api/wallets/bulk           { text, kind? } add many ("name address" per line, any order / commas)
 *   PATCH  /api/wallets/:address       { label?, active?, kind? } edit / pause
 *   DELETE /api/wallets/:address       remove
 *   GET    /api/kols                   coins KOLs bought in the last hour (most KOLs first)
 *   GET    /api/wallets/:address/report  Solscan history → trading patterns + copy simulation
 */
import type { FastifyInstance } from 'fastify';
import { recordEvent } from '../../lib/bot-events';
import { prisma } from '../../lib/prisma';
import { isValidPubkey } from '../../lib/pumpfun';
import { redis } from '../../lib/redis';
import { getConfig } from '../../config/runtime-config';
import { kolBoard } from '../../scanner/kol-signal';
import { walletReport } from '../../learner/wallet-report';
import { solscanUsage } from '../../lib/solscan';
import type { ApiDeps } from '../deps';

/**
 * Parse a pasted wallet list: one wallet per line, "name address", "address name",
 * "address,name" or just the address. Pure.
 */
export function parseWalletList(text: string): { valid: Array<{ address: string; label: string | null }>; invalid: string[] } {
  const valid = new Map<string, string | null>();
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[\s,;|\t]+/).filter(Boolean);
    const addr = parts.find((p) => isValidPubkey(p));
    if (!addr) {
      invalid.push(line.slice(0, 80));
      continue;
    }
    const label = parts.filter((p) => p !== addr).join(' ').replace(/^@/, '').slice(0, 40) || null;
    valid.set(addr, label ?? valid.get(addr) ?? null);
  }
  return { valid: [...valid.entries()].map(([address, label]) => ({ address, label })), invalid };
}

export async function walletsRoutes(app: FastifyInstance, deps?: ApiDeps): Promise<void> {
  /** The most profitable wallets the bot has seen (~7 days; creators and snipers excluded). */
  app.get('/api/smart-wallets', async () => {
    const rows = (await deps?.walletPnl?.leaderboard(25)) ?? [];
    const known = new Map((await prisma.trackedWallet.findMany({ where: { address: { in: rows.map((r) => r.wallet) } }, select: { address: true, label: true, kind: true, active: true } })).map((w) => [w.address, w]));
    return rows.map((r) => ({ ...r, label: known.get(r.wallet)?.label ?? null, tracked: known.get(r.wallet)?.active ?? false }));
  });

  /** Wallet analyzer (Solscan): trading patterns + copy simulation. ?pages=1–10 (100 swaps each), ?refresh=1. */
  app.get<{ Params: { address: string }; Querystring: { pages?: string; refresh?: string } }>('/api/wallets/:address/report', async (req, reply) => {
    const { address } = req.params;
    if (!isValidPubkey(address)) return reply.code(400).send({ error: 'not a Solana address' });
    try {
      const report = await walletReport(address, Number(req.query.pages ?? 5), req.query.refresh === '1');
      return { ...report, usage: await solscanUsage() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

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
        kind: w.kind,
        notes: w.notes,
        source: w.source,
        pnlSol: w.score14d,
        winRate: w.winRate,
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

  app.post<{ Body: { address?: string; label?: string; kind?: string } }>('/api/wallets', async (req, reply) => {
    const address = String(req.body?.address ?? '').trim();
    const label = String(req.body?.label ?? '').trim().slice(0, 40) || null;
    const kind = req.body?.kind === 'KOL' ? 'KOL' : 'COPY';
    if (!isValidPubkey(address)) return reply.code(400).send({ error: 'That is not a valid Solana wallet address' });
    const w = await prisma.trackedWallet.upsert({ where: { address }, update: { label, kind, active: true }, create: { address, label, kind, source: 'MANUAL' } });
    void recordEvent({ module: 'api', type: 'wallet_added', message: `Tracking wallet ${label ?? address}`, data: { address } });
    return w;
  });

  app.post<{ Body: { text?: string; kind?: string } }>('/api/wallets/bulk', async (req, reply) => {
    const kind = req.body?.kind === 'COPY' ? 'COPY' : 'KOL';
    const rows = parseWalletList(String(req.body?.text ?? ''));
    if (!rows.valid.length) return reply.code(400).send({ error: 'No valid Solana addresses found', invalid: rows.invalid.slice(0, 10) });
    let added = 0;
    for (const r of rows.valid.slice(0, 500)) {
      await prisma.trackedWallet.upsert({ where: { address: r.address }, update: { label: r.label ?? undefined, kind, active: true }, create: { address: r.address, label: r.label, kind, source: 'MANUAL' } });
      added++;
    }
    void recordEvent({ module: 'api', type: 'wallets_imported', message: `Imported ${added} ${kind} wallets` });
    return { ok: true, added, invalid: rows.invalid.slice(0, 20) };
  });

  app.get('/api/kols', async () => {
    const c = getConfig().kol;
    const board = await kolBoard(redis, c);
    const tokens = await prisma.token.findMany({ where: { mint: { in: board.map((b) => b.mint) } }, select: { mint: true, symbol: true } });
    const sym = new Map(tokens.map((t) => [t.mint, t.symbol]));
    return { windowMin: c.windowMin, coins: board.map((b) => ({ ...b, symbol: sym.get(b.mint) ?? null })) };
  });

  app.patch<{ Params: { address: string }; Body: { label?: string; active?: boolean; kind?: string } }>('/api/wallets/:address', async (req, reply) => {
    const data: { label?: string | null; active?: boolean; kind?: string } = {};
    if (req.body?.kind === 'KOL' || req.body?.kind === 'COPY') data.kind = req.body.kind;
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
