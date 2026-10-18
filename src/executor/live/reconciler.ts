/**
 * Live only: every `live.reconcileSec` the wallet's real token balances are compared with the open LIVE positions.
 * A mismatch marks the position for manual review (entryContext.review) and logs a WARN; a token nobody explains is
 * reported as an orphan. Nothing is ever bought or sold automatically to "fix" it.
 */
import type { Connection, PublicKey } from '@solana/web3.js';
import { recordEvent } from '../../lib/bot-events';
import { moduleLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './addresses';
import { reconcile } from './guards';
import { liveConfig } from './tx-builder';

const log = moduleLogger('live-reconcile');

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private readonly reported = new Set<string>();

  constructor(private readonly conn: Connection, private readonly owner: PublicKey) {}

  start(): void {
    const every = Math.max(15, liveConfig().reconcileSec) * 1000;
    this.timer = setInterval(() => void this.run().catch((e: Error) => log.warn({ err: e.message }, 'reconcile failed')), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async chainBalances(): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const r = await this.conn.getParsedTokenAccountsByOwner(this.owner, { programId }, 'confirmed');
      for (const a of r.value) {
        const info = (a.account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed?.info;
        if (info?.mint && info.tokenAmount?.amount) out.set(info.mint, (out.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
    }
    return out;
  }

  async run(): Promise<void> {
    const positions = await prisma.position.findMany({ where: { mode: 'LIVE', status: 'OPEN' }, select: { id: true, mint: true, tokenAmountRaw: true, remainingPct: true, entryContext: true } });
    const chain = await this.chainBalances();
    const r = reconcile(positions, chain, liveConfig().reconcileTolPct);
    for (const m of r.mismatches) {
      const p = positions.find((x) => x.id === m.id);
      const ctx = (p?.entryContext ?? {}) as Record<string, unknown>;
      if (ctx.review) continue;
      const why = `chain holds ${m.onChain} raw tokens, the database expects ${m.expected}`;
      await prisma.position.update({ where: { id: m.id }, data: { entryContext: { ...ctx, review: { why, at: new Date().toISOString() } } as object } });
      void recordEvent({ level: 'WARN', module: 'live', type: 'reconcile_mismatch', mint: m.mint, message: `Live position needs manual review: ${why}` });
    }
    const day = new Date().toISOString().slice(0, 10);
    for (const o of r.orphans) {
      const k = `${day}:${o.mint}`;
      if (this.reported.has(k)) continue;
      this.reported.add(k);
      void recordEvent({ level: 'WARN', module: 'live', type: 'reconcile_orphan', mint: o.mint, message: `Wallet holds ${o.amount} raw tokens of ${o.mint.slice(0, 6)}… with no open live position — check manually (nothing is sold automatically)` });
    }
  }
}
