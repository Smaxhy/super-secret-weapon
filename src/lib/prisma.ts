/** Single shared Prisma client (one connection pool for the whole process). */
import { PrismaClient, type Position } from '@prisma/client';

export const prisma = new PrismaClient({
  log: [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }],
});

/**
 * The newest CLOSED position on a mint. The "trade closed" bus event is sent
 * from inside the sell's database transaction, so listeners can run before the
 * close is committed — wait a moment and retry.
 */
export async function closedPosition(mint: string, waitsMs: readonly number[] = [1500, 4000]): Promise<Position | null> {
  for (const ms of waitsMs) {
    await new Promise((r) => setTimeout(r, ms));
    const p = await prisma.position.findFirst({ where: { mint, status: 'CLOSED' }, orderBy: { closedAt: 'desc' } });
    if (p && p.closedAt && Date.now() - p.closedAt.getTime() < 5 * 60_000) return p;
  }
  return null;
}
