/**
 * Backtest exit settings on the archived real trade tapes (learner/backtester.ts).
 *   npm run backtest            last 7 days
 *   npm run backtest -- 3       last 3 days
 * On the VPS: docker compose exec bot node -e "require('./dist/learner/backtester').runBacktest(7).then(r=>console.log(JSON.stringify(r,null,1)))"
 * (or open the dashboard: Performance → "Backtest: other exits on the same trades").
 */
import { refreshConfig } from '../src/config/runtime-config';
import { runBacktest } from '../src/learner/backtester';
import { prisma } from '../src/lib/prisma';

async function main(): Promise<void> {
  await refreshConfig();
  const r = await runBacktest(Number(process.argv[2] ?? 7) || 7);
  console.log(`${r.trades} trades on ${r.tapes} tapes (last ${r.days} days) — real result: ${r.actual ? `${r.actual.avgPnlPct}% avg, ${r.actual.winRatePct}% wins` : 'n/a'}`);
  for (const v of r.variants) console.log(`  ${v.id.padEnd(2)} ${v.name.padEnd(40)} n=${String(v.n).padStart(4)}  avg ${String(v.avgPnlPct).padStart(6)}%  median ${String(v.medianPnlPct).padStart(6)}%  wins ${String(v.winRatePct).padStart(3)}%  vs real ${v.vsActualPct >= 0 ? '+' : ''}${v.vsActualPct}`);
  console.log(r.note);
  await prisma.$disconnect();
  process.exit(0);
}
void main();
