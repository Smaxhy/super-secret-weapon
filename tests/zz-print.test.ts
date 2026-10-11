import { it } from 'vitest';
import { SCENARIOS } from './scenarios';
import { currentPolicy, legacyPolicy, simulateToken, summarisePolicy } from '../src/learner/backtester';
it('print', () => {
  for (const p of [legacyPolicy(), currentPolicy()]) {
    const results = SCENARIOS.map((s) => simulateToken(s.tape, s.meta, p));
    console.log('\n#### ' + p.name);
    for (const r of results) {
      if (r.entered) console.log(`${r.symbol.padEnd(6)} ENTER t+${r.entryAtSec}s ${r.setup.padEnd(10)} score ${r.score.toFixed(1)} pnl ${r.pnlSol.toFixed(4)} peak ${r.peakMultiple.toFixed(2)}x exit ${r.exitMultiple.toFixed(2)}x held ${r.heldSec}s ${r.exitReason} | ${r.sells.map(s=>`${s.reason}@${s.atSec}s ${s.pct.toFixed(0)}% ${s.multiple.toFixed(2)}x`).join(', ')}`);
      else console.log(`${r.symbol.padEnd(6)} SKIP best ${r.bestScore.toFixed(1)} peakAfter ${r.peakAfter.toFixed(2)} | ${r.reasons.slice(0,3).join('; ')}`);
    }
    const s = summarisePolicy(p.name, results);
    console.log(JSON.stringify({ trades: s.trades, winRate: s.winRate, pnl: s.pnlSol, ror: s.returnOnRisk, pf: s.profitFactor, dd: s.maxDrawdownSol, capture: s.captureRatio, held: s.avgHeldSec }));
  }
});
