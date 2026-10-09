/**
 * Find PAPER sells that look like pricing bugs rather than real wins.
 * READ-ONLY: it only prints; nothing in the database is changed.
 *
 * A sell is flagged when:
 *   - its fill price is more than 25x the position's entry price, or
 *   - its P&L is more than 5x the position's size (e.g. +3 SOL on a 0.5 SOL position).
 *
 * Run on the VPS (the bot image has no scripts/ folder, so copy it in first):
 *   cd /root/bot
 *   docker compose cp scripts/find-suspicious-trades.ts bot:/app/find-suspicious-trades.ts
 *   docker compose exec bot npx -y tsx find-suspicious-trades.ts
 * Options:  --multiple=25  --pnl-x=5   (thresholds)
 *
 * Only imports @prisma/client so it runs anywhere the bot's node_modules are.
 */
import { PrismaClient } from '@prisma/client';

const arg = (name: string, def: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
};

async function main(): Promise<void> {
  const maxMultiple = arg('multiple', 25);
  const maxPnlX = arg('pnl-x', 5);
  const prisma = new PrismaClient();
  try {
    const sells = await prisma.trade.findMany({
      where: { mode: 'PAPER', side: 'SELL', status: 'SIMULATED' },
      include: { position: { select: { id: true, sizeSol: true, entryPriceSol: true, realizedPnlSol: true, status: true, openedAt: true, closedAt: true, token: { select: { symbol: true } } } } },
      orderBy: { createdAt: 'asc' },
    });

    const flagged: Array<Record<string, string | number>> = [];
    const positions = new Map<string, { symbol: string; sizeSol: number; realizedPnlSol: number; suspiciousPnl: number }>();
    for (const t of sells) {
      const p = t.position;
      if (!p) continue;
      const ctx = (t.context ?? {}) as { pnlSol?: number; multiple?: number; pct?: number };
      const multiple = p.entryPriceSol > 0 ? t.priceSol / p.entryPriceSol : 0;
      const pnl = typeof ctx.pnlSol === 'number' ? ctx.pnlSol : NaN;
      const tooHigh = multiple > maxMultiple;
      const tooMuchPnl = Number.isFinite(pnl) && pnl > maxPnlX * p.sizeSol;
      if (!tooHigh && !tooMuchPnl) continue;
      flagged.push({
        trade: t.id,
        position: p.id,
        symbol: p.token.symbol,
        mint: t.mint,
        at: t.createdAt.toISOString().replace('T', ' ').slice(0, 19),
        sizeSol: +p.sizeSol.toFixed(4),
        soldPct: typeof ctx.pct === 'number' ? +ctx.pct.toFixed(2) : '?',
        receivedSol: +t.amountSol.toFixed(4),
        pnlSol: Number.isFinite(pnl) ? +pnl.toFixed(4) : '?',
        multiple: +multiple.toFixed(1),
        why: [tooHigh ? `>${maxMultiple}x entry` : '', tooMuchPnl ? `pnl >${maxPnlX}x size` : ''].filter(Boolean).join(', '),
      });
      const agg = positions.get(p.id) ?? { symbol: p.token.symbol, sizeSol: p.sizeSol, realizedPnlSol: p.realizedPnlSol, suspiciousPnl: 0 };
      if (Number.isFinite(pnl)) agg.suspiciousPnl += pnl;
      positions.set(p.id, agg);
    }

    console.log(`Checked ${sells.length} PAPER sells — ${flagged.length} look suspicious (>${maxMultiple}x entry price or P&L >${maxPnlX}x position size).\n`);
    if (!flagged.length) return;
    console.table(flagged);

    const total = [...positions.values()].reduce((s, p) => s + p.suspiciousPnl, 0);
    console.log('\nPer position (realised P&L as stored, and the part that came from the flagged sells):');
    console.table([...positions.entries()].map(([id, p]) => ({ position: id, symbol: p.symbol, sizeSol: +p.sizeSol.toFixed(4), realizedPnlSol: +p.realizedPnlSol.toFixed(4), fromFlaggedSells: +p.suspiciousPnl.toFixed(4) })));
    console.log(`\nP&L from flagged sells: ${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL.`);
    console.log('Paper balance = starting balance + all PAPER trades, so these sells inflate it by about that much.');
    console.log('To reset, review the positions above and delete/adjust them (and their trades) — or wipe all PAPER trades/positions to restart from the starting balance.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
