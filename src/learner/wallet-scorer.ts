/**
 * Wallet Scorer — rolling 14-day performance scores for tracked wallets.
 *
 * Runs daily (alongside the weight adjuster) and updates each tracked wallet's
 * score based on how their buys have performed:
 *
 *   score14d = (wins / total) × avgWinMultiple
 *
 * Where a "win" is a token that went ≥ 1.5x from the wallet's buy price
 * within 1 hour, and avgWinMultiple is how far winners went on average.
 *
 * Wallets with consistently high scores get their weight increased (max 1.0),
 * which amplifies their signal in the evaluator. Poor performers get
 * downweighted or deactivated.
 *
 * The scorer also discovers new smart-money wallets from trade data:
 * wallets that appear in ≥ 3 tokens that went 2x+ in the last 14 days
 * and aren't already tracked get added with source=DISCOVERED.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('wallet-scorer');

const LOOKBACK_DAYS = 14;
const WIN_THRESHOLD_MULTIPLE = 1.5;
const DISCOVERY_MIN_WINS = 3;
const DISCOVERY_MIN_MULTIPLE = 2.0;

export class WalletScorer {
  private task: ScheduledTask | null = null;

  start(): void {
    // Run at 00:30 UTC daily (after the weight adjuster at 00:10)
    this.task = cron.schedule('30 0 * * *', () => void this.run(), { timezone: 'UTC' });
    log.info('wallet scorer scheduled (daily 00:30 UTC)');
  }

  stop(): void {
    void this.task?.stop();
  }

  async run(): Promise<void> {
    try {
      await this.scoreExisting();
      await this.discoverNew();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'wallet scorer failed');
    }
  }

  /** Score all active tracked wallets based on their recent trade outcomes. */
  private async scoreExisting(): Promise<void> {
    const wallets = await prisma.trackedWallet.findMany({ where: { active: true } });
    if (wallets.length === 0) return;

    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60_000);

    for (const wallet of wallets) {
      try {
        // Find all tokens this wallet bought in our tape data
        const tapes = await prisma.tokenTape.findMany({
          where: { createdAt: { gte: since } },
          select: { mint: true, tape: true, wallets: true },
        });

        let wins = 0;
        let total = 0;
        let winMultiples: number[] = [];

        for (const t of tapes) {
          const walletList = t.wallets as string[];
          const walletIdx = walletList.indexOf(wallet.address);
          if (walletIdx === -1) continue;

          // This wallet traded this token
          const tape = t.tape as Array<{ w: number; b: 1 | 0; s: number; p: number; t: number }>;
          const buys = tape.filter(trade => trade.w === walletIdx && trade.b === 1);
          if (buys.length === 0) continue;

          total++;

          // Check what price the token reached after their first buy
          const firstBuy = buys[0]!;
          const buyPrice = firstBuy.p;
          if (buyPrice <= 0) continue;

          // Find peak price in the 1 hour after their buy
          const afterBuy = tape.filter(trade => trade.t > firstBuy.t && trade.t <= firstBuy.t + 3600_000);
          const peakAfter = afterBuy.length > 0
            ? Math.max(...afterBuy.map(trade => trade.p))
            : buyPrice;
          const multiple = peakAfter / buyPrice;

          if (multiple >= WIN_THRESHOLD_MULTIPLE) {
            wins++;
            winMultiples.push(multiple);
          }
        }

        const winRate = total > 0 ? wins / total : 0;
        const avgWinMultiple = winMultiples.length > 0
          ? winMultiples.reduce((a, b) => a + b, 0) / winMultiples.length
          : 0;
        const score14d = winRate * Math.min(avgWinMultiple, 5); // cap at 5x to prevent outlier inflation

        // Adjust weight based on score
        let newWeight = wallet.weight;
        if (total >= 5) {
          if (score14d >= 1.0) newWeight = Math.min(1.0, wallet.weight + 0.1);
          else if (score14d >= 0.5) newWeight = Math.min(1.0, wallet.weight + 0.05);
          else if (score14d < 0.2) newWeight = Math.max(0.1, wallet.weight - 0.1);
        }

        await prisma.$transaction([
          prisma.trackedWallet.update({
            where: { address: wallet.address },
            data: {
              score14d,
              winRate,
              tradeCount: total,
              weight: round3(newWeight),
              // Deactivate wallets that have been consistently bad
              active: !(total >= 10 && score14d < 0.1),
            },
          }),
          prisma.walletScoreHistory.create({
            data: {
              address: wallet.address,
              score14d,
              winRate,
              tradeCount: total,
              weight: round3(newWeight),
            },
          }),
        ]);

        if (total > 0) {
          log.debug(
            { address: wallet.address.slice(0, 8), label: wallet.label, score14d: round3(score14d), winRate: round3(winRate), trades: total },
            `scored wallet`,
          );
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, address: wallet.address.slice(0, 8) }, 'failed to score wallet');
      }
    }

    log.info({ wallets: wallets.length }, 'wallet scoring complete');
  }

  /** Discover new smart-money wallets from recent trade data. */
  private async discoverNew(): Promise<void> {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60_000);

    // Find wallets that appeared early in tokens that pumped
    const tapes = await prisma.tokenTape.findMany({
      where: { createdAt: { gte: since } },
      select: { mint: true, tape: true, wallets: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Count how many "good" tokens each wallet was early on
    const walletWins = new Map<string, number>();
    const walletTotal = new Map<string, number>();

    for (const t of tapes) {
      const walletList = t.wallets as string[];
      const tape = t.tape as Array<{ w: number; b: 1 | 0; s: number; p: number; t: number }>;
      if (tape.length < 10) continue;

      // Was this token a winner? (peak price / first price >= 2x)
      const prices = tape.map(trade => trade.p).filter(p => p > 0);
      if (prices.length === 0) continue;
      const firstPrice = prices[0]!;
      const peakPrice = Math.max(...prices);
      const isWinner = peakPrice / firstPrice >= DISCOVERY_MIN_MULTIPLE;

      // Find early buyers (first 20% of trades)
      const earlyCount = Math.max(5, Math.floor(tape.length * 0.2));
      const earlyTrades = tape.slice(0, earlyCount);
      const earlyBuyers = new Set(
        earlyTrades
          .filter(trade => trade.b === 1)
          .map(trade => walletList[trade.w])
          .filter((w): w is string => w !== undefined),
      );

      for (const wallet of earlyBuyers) {
        walletTotal.set(wallet, (walletTotal.get(wallet) ?? 0) + 1);
        if (isWinner) walletWins.set(wallet, (walletWins.get(wallet) ?? 0) + 1);
      }
    }

    // Find wallets that consistently pick winners
    const existing = await prisma.trackedWallet.findMany({ select: { address: true } });
    const existingSet = new Set(existing.map(w => w.address));
    let discovered = 0;

    for (const [address, wins] of walletWins) {
      if (existingSet.has(address)) continue;
      if (wins < DISCOVERY_MIN_WINS) continue;
      const total = walletTotal.get(address) ?? 0;
      const winRate = total > 0 ? wins / total : 0;
      if (winRate < 0.4) continue; // At least 40% win rate

      await prisma.trackedWallet.create({
        data: {
          address,
          label: `auto-discovered (${wins}/${total} wins)`,
          source: 'DISCOVERED',
          weight: 0.3,
          score14d: winRate,
          winRate,
          tradeCount: total,
        },
      }).catch(() => { /* duplicate key = already exists, fine */ });

      discovered++;
      existingSet.add(address);
    }

    if (discovered > 0) {
      log.info({ discovered }, `🐋 Discovered ${discovered} new smart-money wallets`);
    }
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
