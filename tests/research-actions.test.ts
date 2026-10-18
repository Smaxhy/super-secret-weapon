import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { crowdQuality } from '../src/evaluator/crowd-quality';
import { sniperEntryFails } from '../src/evaluator/sniper';
import { bondRatePct, classifyDeployer, deployerView, type DeployerRec } from '../src/learner/deployer-book';
import { buildMoneyMap, type MoneyRow } from '../src/learner/money-map';
import { emptyRec, type WalletRec } from '../src/learner/wallet-book';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const DC = DEFAULT_CONFIG.deployers;
const rec = (p: Partial<DeployerRec>): DeployerRec => ({ l: 0, g: 0, df: 0, rugs: 0, mcs: [], first: 0, last: 0, mints: [], lts: [], f: '', ...p });

describe('v11.19 — elite (repeat graduator) deployers', () => {
  it('classifies a repeat graduator as elite, a one-off as proven, a lucky mass launcher as mixed', () => {
    expect(classifyDeployer(rec({ l: 5, g: 3 }), false, DC)).toBe('elite');
    expect(classifyDeployer(rec({ l: 3, g: 1 }), false, DC)).toBe('proven');
    expect(classifyDeployer(rec({ l: 40, g: 2 }), false, DC)).toBe('proven'); // 5% bond rate: not elite
    expect(classifyDeployer(rec({ l: 5, g: 3, rugs: 1 }), false, DC)).toBe('rugger');
    expect(bondRatePct(rec({ l: 5, g: 3 }))).toBe(60);
  });
  it('elite gets the elite points and a note', () => {
    const v = deployerView(rec({ l: 5, g: 3, lts: [1, 2, 3, 4, 5], mints: ['a', 'b', 'c', 'd', 'e'] }), { inRugMemory: false, linked: 0, linkedSerial: 0, nowMs: 10 * 86_400_000 }, { ...DC, maxLaunchesPerDay: 0 });
    expect(v.class).toBe('elite');
    expect(v.points).toBe(10);
    expect(v.note).toMatch(/repeat graduator/);
  });
  it('sniper gate: elite coins need half the volume', () => {
    const c = { ...DEFAULT_CONFIG.sniper, eliteVolumeFactor: 0.5 } as never;
    const flow = { buyers: 16, buySol: 7, buySharePct: 70, organicPct: 80 } as never;
    const base = { flow, score: 90, threshold: 70, momentumGateWhy: null, entryQualityVerdict: 'ok', edgeGatePass: true, pressureSellersInControl: false, crowd: null, explore: false, probe: false, risky: false, dipEntry: false } as never;
    expect(sniperEntryFails({ ...base, deployerClass: 'mixed' }, c).some((f) => f.includes('real buyers'))).toBe(true);
    expect(sniperEntryFails({ ...base, deployerClass: 'elite' }, c).some((f) => f.includes('real buyers') || f.includes('SOL bought'))).toBe(false);
  });
});

describe('v11.19 — dump crew among the first 20 buyers', () => {
  const now = 1_700_000_000_000;
  const dumper: WalletRec = { ...emptyRec(1), dumps: 5 };
  const trades = (dumpers: number): CrowdTrade[] => {
    const out: CrowdTrade[] = [];
    for (let i = 0; i < 25; i++) out.push({ t: now - 200_000 + i * 2_000, w: i < dumpers ? `dump${i}` : `w${i}`, buy: true, sol: 0.3, tok: 1000, px: 1e-6, pp: 1e-6 });
    return out;
  };
  const CQ = { ...DEFAULT_CONFIG.wallets.entry, maxDumpersInFirst20: 3 } as never;
  const BOOK = DEFAULT_CONFIG.wallets;
  it('3 known dumpers at the start → rule fail; 2 → fine', () => {
    const q3 = crowdQuality({ trades: trades(3), now, supply: 1e9 }, (w) => (w.startsWith('dump') ? dumper : undefined), () => null, BOOK, CQ)!;
    expect(q3.dumpersInFirst20).toBe(3);
    expect(q3.fails.some((f) => f.includes('dump crew at the start'))).toBe(true);
    const q2 = crowdQuality({ trades: trades(2), now, supply: 1e9 }, (w) => (w.startsWith('dump') ? dumper : undefined), () => null, BOOK, CQ)!;
    expect(q2.dumpersInFirst20).toBe(2);
    expect(q2.fails.some((f) => f.includes('dump crew at the start'))).toBe(false);
  });
});

describe('v11.19 — money map dev-holding splits', () => {
  const row = (flat: Record<string, number>): MoneyRow => ({ mint: 'm', symbol: 'X', strategy: 'SOON', atMs: 1, pnlPct: -5, peakX: 1.05, source: 'outcome', score: 60, bar: 70, why: 'score under the bar', rulesOk: true, flat });
  it('bands dev holding and dev selling; marks elite deployers', () => {
    const m = buildMoneyMap([row({ 'market.devHoldingPct': 0.2, 'market.devSoldFraction': 1 }), row({ 'market.devHoldingPct': 7, 'market.devSoldFraction': 0 }), row({ 'deployer.graduated': 3, 'deployer.launches': 6 })], { hours: 1 });
    const hold = m.dimensions.find((d) => d.key === 'devHold')!;
    expect(hold.groups.map((g) => g.label)).toEqual(['dev sold out (< 1%)', 'dev holds 5–10%']);
    const sold = m.dimensions.find((d) => d.key === 'devSold')!;
    expect(sold.groups.map((g) => g.label)).toEqual(['dev sold nothing', 'dev sold everything']);
    const dep = m.dimensions.find((d) => d.key === 'deployer')!;
    expect(dep.groups[0]!.label).toBe('elite (repeat graduator)');
  });
});
