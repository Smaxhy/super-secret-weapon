/**
 * Tape archiver (from the owner's "big update", Oct 11, rebuilt on the current bot): keeps the real trade-by-trade
 * price path around every PAPER trade, so exit settings can be backtested on what actually happened (backtester.ts).
 *
 * The crowd log only holds ~1 hour per coin in memory, so every 10 minutes the trades of coins we bought in the last
 * 6 hours (from 15 min before the buy to 45 min after the sell) are merged into Postgres (TokenTape, compact rows
 * [tsMs, isBuy, sol, priceSol, walletIdx], ≤ 6,000 trades per coin). Rows older than 14 days are deleted.
 */
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { CrowdTrade } from '../scanner/crowd-tracker';

const log = moduleLogger('tape-archiver');
export type TapeRow = [number, 0 | 1, number, number, number];
const MAX_TRADES = 6_000;

const sig = (x: number) => Number(x.toPrecision(7));

/** Pure: crowd trades → compact rows (+ wallet table). */
export function encodeTape(trades: readonly CrowdTrade[]): { rows: TapeRow[]; wallets: string[] } {
  const wallets: string[] = [];
  const idx = new Map<string, number>();
  const rows: TapeRow[] = [];
  for (const t of trades) {
    const px = t.pp && t.pp > 0 ? t.pp : t.px;
    if (!(px > 0)) continue;
    let i = idx.get(t.w);
    if (i === undefined) {
      i = wallets.length;
      wallets.push(t.w);
      idx.set(t.w, i);
    }
    rows.push([t.t, t.buy ? 1 : 0, Math.round(t.sol * 1e6) / 1e6, sig(px), i]);
  }
  return { rows, wallets };
}

/** Pure: rows → crowd-style trades (price after the trade in both px and pp). */
export function decodeTape(rows: readonly TapeRow[], wallets: readonly string[]): CrowdTrade[] {
  return rows.map(([t, b, sol, px, w]) => ({ t, w: wallets[w] ?? `w${w}`, buy: b === 1, sol, tok: px > 0 ? sol / px : 0, px, pp: px }));
}

/** Pure: merge two tapes, dropping duplicates (same time, side, size, wallet), oldest first, capped. */
export function mergeTrades(a: readonly CrowdTrade[], b: readonly CrowdTrade[], max = MAX_TRADES): CrowdTrade[] {
  const seen = new Set<string>();
  const out: CrowdTrade[] = [];
  for (const t of [...a, ...b]) {
    const k = `${t.t}|${t.buy ? 1 : 0}|${t.sol.toFixed(6)}|${t.w}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  out.sort((x, y) => x.t - y.t);
  return out.length > max ? out.slice(out.length - max) : out;
}

export class TapeArchiver {
  private timer: NodeJS.Timeout | null = null;
  readonly stats = { archived: 0, lastRunAt: 0 };

  constructor(private readonly trades: (mint: string) => readonly CrowdTrade[]) {}

  start(): void {
    const tick = () => void this.run();
    this.timer = setInterval(tick, 10 * 60_000);
    this.timer.unref?.();
    setTimeout(tick, 3 * 60_000).unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = Date.now()): Promise<number> {
    try {
      const ps = await prisma.position.findMany({
        where: { mode: 'PAPER', openedAt: { gte: new Date(now - 6 * 3_600_000) } },
        select: { mint: true, openedAt: true, closedAt: true },
      });
      const windows = new Map<string, { from: number; to: number }>();
      for (const p of ps) {
        const from = p.openedAt.getTime() - 15 * 60_000;
        const to = p.closedAt ? p.closedAt.getTime() + 45 * 60_000 : now;
        const w = windows.get(p.mint);
        windows.set(p.mint, w ? { from: Math.min(w.from, from), to: Math.max(w.to, to) } : { from, to });
      }
      let n = 0;
      for (const [mint, w] of windows) {
        const fresh = this.trades(mint).filter((t) => t.t >= w.from && t.t <= w.to);
        if (!fresh.length) continue;
        const ex = await prisma.tokenTape.findUnique({ where: { mint } });
        const merged = mergeTrades(ex ? decodeTape(ex.tape as TapeRow[], ex.wallets as string[]) : [], fresh);
        if (ex && merged.length === ex.trades) continue;
        const { rows, wallets } = encodeTape(merged);
        if (!rows.length) continue;
        const data = { startMs: BigInt(rows[0]![0]), endMs: BigInt(rows[rows.length - 1]![0]), trades: rows.length, tape: rows as unknown as object, wallets: wallets as unknown as object };
        await prisma.tokenTape.upsert({ where: { mint }, update: data, create: { mint, ...data } });
        n++;
        // Let trades / exits run between coins.
        await new Promise((r) => setImmediate(r));
      }
      await prisma.tokenTape.deleteMany({ where: { updatedAt: { lt: new Date(now - 14 * 86_400_000) } } });
      this.stats.archived += n;
      this.stats.lastRunAt = now;
      if (n) log.debug({ coins: n }, 'trade tapes archived');
      return n;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'tape archive failed');
      return 0;
    }
  }
}
