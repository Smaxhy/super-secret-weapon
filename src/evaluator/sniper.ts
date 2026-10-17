/**
 * Sniper mode (v11.7, owner: "I don't care if it's a few trades, but then each one must be profitable with a big
 * impact"): a buy only when EVERYTHING lines up — real organic volume, a score well over the bar, momentum / entry
 * quality / edge gate / pressure / crowd all green — at the owner's high-conviction size, with exits built for
 * big moves instead of scalps. Pure helpers; the evaluator, trader, sell manager and replay use them.
 */
import type { OrganicFlow } from '../scanner/migrated-scanner';

export interface SniperExits {
  takeProfitTiers: ReadonlyArray<{ multiple: number; sellPct: number }>;
  trailActivateMultiple: number;
  trailPct: number;
  breakEvenFromMultiple: number;
  stopMaxPct: number;
  timeStopMinutes: number;
  timeStopMinPeakMultiple: number;
}

export interface SniperConfig {
  enabled: boolean;
  maxOpen: number;
  minScoreMargin: number;
  volume: { minBuyers: number; minBuySol: number; minBuySharePct: number; minOrganicPct: number };
  requireProvenCrowd: boolean;
  /** v11.10: refuse serial launchers / deployers that rugged before (absent in old saved rows = on). */
  requireDeployerNotSerial?: boolean;
  exits: SniperExits;
}

export interface SniperEntryInput {
  /** 5-minute organic flow (bots, dust, churners removed). null = not enough trades. */
  flow: OrganicFlow | null;
  score: number;
  threshold: number;
  momentumGateWhy: string | null;
  entryQualityVerdict: 'ok' | 'block' | 'boost' | string;
  /** null = the gate didn't judge (not enough trades for that strategy) → counts as green. */
  edgeGatePass: boolean | null;
  pressureSellersInControl: boolean;
  crowd: { provenSolPct: number; fails: readonly string[] } | null;
  explore: boolean;
  probe: boolean;
  risky: boolean;
  dipEntry: boolean;
  /** v11.10 deployer class (null = unknown / not checked) */
  deployerClass?: string | null;
}

/** Pure: why Sniper mode refuses this buy (empty = take it). */
export function sniperEntryFails(i: SniperEntryInput, c: SniperConfig): string[] {
  if (!c.enabled) return [];
  const out: string[] = [];
  const v = c.volume;
  if (!i.flow) out.push('not enough real trading in the last 5 min');
  else {
    if (i.flow.buyers < v.minBuyers) out.push(`${i.flow.buyers} real buyers in 5 min < ${v.minBuyers}`);
    if (i.flow.buySol < v.minBuySol) out.push(`${i.flow.buySol.toFixed(1)} SOL bought in 5 min < ${v.minBuySol}`);
    if (i.flow.buySharePct < v.minBuySharePct) out.push(`buys only ${Math.round(i.flow.buySharePct)}% of volume < ${v.minBuySharePct}%`);
    if (i.flow.organicPct < v.minOrganicPct) out.push(`only ${Math.round(i.flow.organicPct)}% organic volume < ${v.minOrganicPct}%`);
  }
  if (i.score < i.threshold + c.minScoreMargin) out.push(`score ${i.score.toFixed(1)} is not ${c.minScoreMargin} over the bar ${i.threshold.toFixed(0)}`);
  if (i.momentumGateWhy) out.push(`momentum: ${i.momentumGateWhy}`);
  if (i.entryQualityVerdict !== 'ok' && i.entryQualityVerdict !== 'boost') out.push('entry quality not green');
  if (i.edgeGatePass === false) out.push('edge gate: the strategy loses after costs');
  if (i.pressureSellersInControl) out.push('sellers in control');
  if (i.crowd?.fails.length) out.push(`crowd: ${i.crowd.fails[0]}`);
  if (c.requireProvenCrowd && (i.crowd?.provenSolPct ?? 0) < 20) out.push(`only ${Math.round(i.crowd?.provenSolPct ?? 0)}% of buying from proven wallets (needs 20%)`);
  if ((c.requireDeployerNotSerial ?? true) && (i.deployerClass === 'serial' || i.deployerClass === 'rugger')) out.push(`deployer is a ${i.deployerClass === 'serial' ? 'serial launcher' : 'known rugger'}`);
  if (i.explore) out.push('learning trades are off in sniper mode');
  if (i.probe) out.push('probe trades are off in sniper mode');
  if (i.risky) out.push('half-size risky entries are off in sniper mode');
  return out;
}

const STRATEGIES = ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SWING', 'RUNNER'] as const;

/** Pure: the exit overlay Sniper mode lays over EVERY strategy's exit rules (deep-merged last, so it wins). */
export function sniperExitOverlay(e: SniperExits, baseStopMinPct = 12): Record<string, unknown> {
  const minutes: Record<string, number> = {};
  for (const s of STRATEGIES) minutes[s] = e.timeStopMinutes;
  return {
    takeProfitTiers: e.takeProfitTiers.map((t) => ({ multiple: t.multiple, sellPct: t.sellPct })),
    trailingStopActivateMultiple: e.trailActivateMultiple,
    trail: { breakEvenAfterMultiple: e.breakEvenFromMultiple, ladder: [{ fromMultiple: e.trailActivateMultiple, pct: e.trailPct }] },
    stopLoss: { minPct: Math.min(baseStopMinPct, e.stopMaxPct), maxPct: e.stopMaxPct, maxPctByStrategy: {}, minPctByStrategy: {} },
    timeStop: { minutes, defaultMinutes: e.timeStopMinutes, minPeakMultiple: e.timeStopMinPeakMultiple },
  };
}

/** Pure: the position size in sniper mode — the owner's conviction size under the existing hard caps only. */
export function sniperSize(i: { sizeSol: number; maxPctOfCapital: number; capital: number; budget: number; balance: number; reserve: number }): number {
  return Math.max(0, Math.min(i.sizeSol, (i.capital * i.maxPctOfCapital) / 100, i.budget, i.balance - i.reserve));
}
