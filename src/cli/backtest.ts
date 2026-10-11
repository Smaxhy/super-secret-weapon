/**
 * Backtest CLI — replays archived tapes through the legacy and current rules.
 *
 *   npm run backtest                 last 7 days, all archived tapes
 *   npm run backtest -- --days 3     narrower window
 *   npm run backtest -- --json       machine-readable output
 *   npm run backtest -- --threshold 70 --size 0.15   try a variant alongside
 *
 * On the VPS (compiled image):  docker compose exec bot node dist/cli/backtest.js
 *
 * Reads TokenTape (written by the tape archiver) + Token facts. Also prints the
 * outcome log (what evaluated tokens did an hour later) so entry quality can
 * be judged independently of exits.
 */
import { prisma } from '../lib/prisma';
import { getSolUsd } from '../lib/sol-price';
import { decodeTape, type TapeRow } from '../learner/tape-archiver';
import { currentPolicy, legacyPolicy, runComparison, type Policy, type PolicyReport, type TokenMeta } from '../learner/backtester';
import type { WalletFeatures } from '../evaluator/wallet-analyzer';
import type { TapeTrade } from '../scanner/live-state';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadTokens(days: number, limit: number): Promise<Array<{ tape: TapeTrade[]; meta: TokenMeta }>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const tapes = await prisma.tokenTape.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: limit });
  const tokens = await prisma.token.findMany({ where: { mint: { in: tapes.map((t) => t.mint) } } });
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  // Creator features the live wallet analyzer computed (only stored when it ran) — newest evaluation wins.
  const evals = await prisma.evaluation.findMany({ where: { mint: { in: tapes.map((t) => t.mint) } }, orderBy: { createdAt: 'asc' }, select: { mint: true, features: true } });
  const walletByMint = new Map<string, WalletFeatures>();
  for (const e of evals) {
    const stored = e.features as { creator?: unknown; features?: Partial<WalletFeatures> } | null;
    const f = stored?.features;
    if (stored?.creator && f && typeof f.creatorLaunches === 'number' && typeof f.creatorSuccess === 'number' && typeof f.funderReuse === 'number' && typeof f.walletAge === 'number') {
      walletByMint.set(e.mint, { creatorLaunches: f.creatorLaunches, creatorSuccess: f.creatorSuccess, funderReuse: f.funderReuse, walletAge: f.walletAge });
    }
  }
  const solUsd = (await getSolUsd().catch(() => null)) ?? 150;
  const out: Array<{ tape: TapeTrade[]; meta: TokenMeta }> = [];
  for (const t of tapes) {
    const tok = byMint.get(t.mint);
    if (!tok || tok.safetyScore === null || tok.safetyHardFail === null) continue;
    out.push({
      tape: decodeTape(t.tape as TapeRow[], t.wallets as string[]),
      meta: {
        mint: t.mint,
        symbol: tok.symbol,
        createdAtMs: tok.createdAt.getTime(),
        creator: tok.creator,
        safetyScore: tok.safetyScore,
        safetyHardFail: tok.safetyHardFail,
        curve: { initialVirtualSolReserves: tok.initialVirtualSolReserves, initialVirtualTokenReserves: tok.initialVirtualTokenReserves, initialRealTokenReserves: tok.initialRealTokenReserves, totalSupply: tok.totalSupply },
        solUsd,
        complete: t.complete || tok.status === 'COMPLETED',
        walletFeatures: walletByMint.get(t.mint),
      },
    });
  }
  return out;
}

async function outcomeLog(days: number): Promise<Array<{ decision: string; outcome: string; count: number; avgScore: number }>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const rows = await prisma.missedOpportunity.groupBy({ by: ['decision', 'outcome'], where: { createdAt: { gte: since } }, _count: { _all: true }, _avg: { scoreAtDecision: true } });
  return rows.map((r) => ({ decision: r.decision, outcome: r.outcome, count: r._count._all, avgScore: Math.round((r._avg.scoreAtDecision ?? 0) * 10) / 10 })).sort((a, b) => b.count - a.count);
}

function printReport(r: PolicyReport): void {
  const n = (x: number | null, d = 4) => (x === null ? '—' : x === Infinity ? '∞' : x.toFixed(d));
  console.log(`\n═══ ${r.policy} ═══`);
  console.log(`tokens ${r.tokens} · trades ${r.trades} · win rate ${n(r.winRate, 1)}% · P&L ${n(r.pnlSol)} SOL on ${n(r.riskedSol, 2)} SOL risked (return on risk ${n(r.returnOnRisk, 3)})`);
  console.log(`avg trade ${n(r.avgPnlSol)} · avg win ${n(r.avgWinSol)} · avg loss ${n(r.avgLossSol)} · profit factor ${n(r.profitFactor, 2)} · max drawdown ${n(r.maxDrawdownSol)} SOL`);
  console.log(`avg hold ${r.avgHeldSec ?? '—'}s · avg peak ${n(r.avgPeakMultiple, 2)}x · capture ratio ${n(r.captureRatio, 2)} · missed ≥2x after skipping: ${r.missed}`);
  if (r.byExitReason.length) console.log('exits:   ' + r.byExitReason.map((e) => `${e.reason} ×${e.trades} (${e.pnlSol >= 0 ? '+' : ''}${e.pnlSol})`).join('  '));
  if (r.bySetup.length) console.log('setups:  ' + r.bySetup.map((s) => `${s.setup} ×${s.trades} ${s.winRate}% (${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol})`).join('  '));
  if (r.skipReasons.length) console.log('skips:   ' + r.skipReasons.slice(0, 5).map((s) => `${s.reason} ×${s.count}`).join('  '));
}

async function main(): Promise<void> {
  const days = Number(arg('days') ?? 7);
  const limit = Number(arg('limit') ?? 2000);
  const tokens = await loadTokens(days, limit);
  const policies: Policy[] = [legacyPolicy(), currentPolicy()];
  const threshold = arg('threshold');
  const size = arg('size');
  if (threshold || size) {
    policies.push(currentPolicy({ name: `variant(th=${threshold ?? 'def'},size=${size ?? 'def'})`, ...(threshold ? { threshold: Number(threshold) } : {}), ...(size ? { sizeSol: Number(size) } : {}) }));
  }
  const { reports } = runComparison(tokens, policies);
  const outcomes = await outcomeLog(days);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ days, tokens: tokens.length, reports, outcomes }, null, 2));
    return;
  }
  console.log(`Backtest over ${tokens.length} archived tapes from the last ${days} day(s)`);
  if (tokens.length === 0) console.log('No tapes yet — the archiver stores tokens that score ≥ 60 or get traded. Let the bot run for a while first.');
  for (const r of reports) printReport(r);
  if (outcomes.length) {
    console.log('\n═══ outcome log (what evaluated tokens did 1h later) ═══');
    for (const o of outcomes) console.log(`${o.decision.padEnd(7)} ${o.outcome.padEnd(10)} ×${String(o.count).padEnd(5)} avg score ${o.avgScore}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
