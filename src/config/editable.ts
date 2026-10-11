/**
 * Settings the owner can change on the Controls page ("Buy rules per strategy"). Only these paths can be written
 * through PUT /api/controls/rules — each has a label, a group and safe limits. Paths are `section.key.subkey`.
 */
export interface EditableSetting {
  key: string;
  group: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  help?: string;
}

const S = (group: string, key: string, label: string, min: number, max: number, unit?: string, step?: number, help?: string): EditableSetting => ({ group, key, label, min, max, unit, step, help });

export const EDITABLE: EditableSetting[] = [
  // ---- Migrated coins (PumpSwap) ----
  S('Migrated coins', 'trading.enabledStrategies.MIGRATION_MOMENTUM', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Migrated coins', 'focus.migrated.minMarketCapUsd', 'Min market cap', 0, 10_000_000, '$', 1000),
  S('Migrated coins', 'focus.migrated.minLiquidityUsd', 'Min liquidity', 0, 5_000_000, '$', 500),
  S('Migrated coins', 'focus.migrated.minTotalFeesSol', 'Min total fees paid', 0, 1000, 'SOL', 0.5),
  S('Migrated coins', 'entry.minHoldersMigration', 'Min holders', 0, 5000, undefined, 5),
  S('Migrated coins', 'focus.migrated.minActiveWallets5m', 'Min active wallets (5 min)', 0, 1000, undefined, 1),
  S('Migrated coins', 'focus.migrated.noEntryFirstSec', 'No buys in the first … after migration', 0, 3600, 's', 30),
  S('Migrated coins', 'focus.migrated.scan.minOrganicBuyers5m', 'Real buyers needed (5 min)', 0, 500, undefined, 1),
  S('Migrated coins', 'focus.migrated.scan.minOrganicBuySol5m', 'Real buying needed (5 min)', 0, 500, 'SOL', 0.5),
  S('Migrated coins', 'focus.migrated.scan.minBuySharePct', 'Buyers share of trades', 0, 100, '%', 1),
  S('Migrated coins', 'focus.migrated.scan.maxRun3mPct', "Don't chase: max rise in 3 min", 0, 1000, '%', 5),
  S('Migrated coins', 'focus.migrated.scoreThresholdDelta', 'Score bar shift (− = easier)', -40, 40, 'pts', 1),
  S('Migrated coins', 'focus.migrated.sizeMultiplier', 'Trade size ×', 0.1, 3, '×', 0.1),
  S('Migrated coins', 'trading.maxOpenByStrategy.MIGRATION_MOMENTUM', 'Max open at once', 0, 30, undefined, 1),
  S('Migrated coins', 'trading.allocation.MIGRATION_MOMENTUM', 'Share of the budget', 0, 1, '0–1', 0.05),
  S('Migrated coins', 'exit.stopLoss.maxPctByStrategy.MIGRATION_MOMENTUM', 'Stop loss (max)', 5, 30, '%', 1),

  // ---- Soon (curve 70–90%) ----
  S('Soon (about to migrate)', 'trading.enabledStrategies.SOON', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Soon (about to migrate)', 'focus.soon.minCurvePct', 'Bonding curve from', 0, 100, '%', 1),
  S('Soon (about to migrate)', 'focus.soon.maxCurvePct', 'Bonding curve up to', 0, 100, '%', 1),
  S('Soon (about to migrate)', 'focus.soon.minMarketCapUsd', 'Min market cap', 0, 1_000_000, '$', 1000),
  S('Soon (about to migrate)', 'focus.soon.minVolumeUsd', 'Min volume', 0, 5_000_000, '$', 1000),
  S('Soon (about to migrate)', 'focus.soon.minTotalFeesSol', 'Min total fees paid', 0, 500, 'SOL', 0.5),
  S('Soon (about to migrate)', 'focus.soon.minActiveWallets5m', 'Min active wallets (5 min)', 0, 1000, undefined, 1),
  S('Soon (about to migrate)', 'focus.soon.scoreThresholdDelta', 'Score bar shift (− = easier)', -40, 40, 'pts', 1),
  S('Soon (about to migrate)', 'focus.soon.sizeMultiplier', 'Trade size ×', 0.1, 3, '×', 0.1),
  S('Soon (about to migrate)', 'trading.maxOpenByStrategy.SOON', 'Max open at once', 0, 30, undefined, 1),
  S('Soon (about to migrate)', 'trading.allocation.SOON', 'Share of the budget', 0, 1, '0–1', 0.05),

  // ---- New pairs ----
  S('New pairs', 'trading.enabledStrategies.CURVE_SNIPE', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('New pairs', 'focus.newPair.minAgeSec', 'Coin at least … old', 0, 3600, 's', 5),
  S('New pairs', 'focus.newPair.maxAgeSec', 'Coin at most … old', 30, 7200, 's', 30),
  S('New pairs', 'focus.newPair.minMarketCapUsd', 'Min market cap', 0, 1_000_000, '$', 500),
  S('New pairs', 'focus.newPair.maxMarketCapUsd', 'Max market cap', 0, 10_000_000, '$', 500),
  S('New pairs', 'focus.newPair.minCurveSol', 'Min SOL in the curve', 0, 85, 'SOL', 0.5),
  S('New pairs', 'focus.newPair.maxCurvePct', 'Bonding curve up to', 0, 100, '%', 1),
  S('New pairs', 'entry.minHoldersCurveSnipe', 'Min holders', 0, 2000, undefined, 1),
  S('New pairs', 'trading.maxOpenByStrategy.CURVE_SNIPE', 'Max open at once', 0, 30, undefined, 1),
  S('New pairs', 'trading.allocation.CURVE_SNIPE', 'Share of the budget', 0, 1, '0–1', 0.05),

  // ---- Runners ----
  S('Runners (curve coins taking off)', 'trading.enabledStrategies.RUNNER', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Runners (curve coins taking off)', 'runner.scan.minCurvePct', 'Bonding curve from', 0, 100, '%', 1),
  S('Runners (curve coins taking off)', 'runner.scan.maxCurvePct', 'Bonding curve up to', 0, 100, '%', 1),
  S('Runners (curve coins taking off)', 'runner.scan.minMarketCapUsd', 'Min market cap', 0, 1_000_000, '$', 500),
  S('Runners (curve coins taking off)', 'runner.scan.minOrganicBuyers5m', 'Real buyers needed (5 min)', 0, 500, undefined, 1),
  S('Runners (curve coins taking off)', 'runner.scan.minOrganicBuySol5m', 'Real buying needed (5 min)', 0, 500, 'SOL', 0.5),
  S('Runners (curve coins taking off)', 'runner.scoreThresholdDelta', 'Score bar shift (− = easier)', -40, 40, 'pts', 1),
  S('Runners (curve coins taking off)', 'runner.sizeMultiplier', 'Trade size ×', 0.1, 3, '×', 0.1),
  S('Runners (curve coins taking off)', 'trading.maxOpenByStrategy.RUNNER', 'Max open at once', 0, 30, undefined, 1),
  S('Runners (curve coins taking off)', 'trading.allocation.RUNNER', 'Share of the budget', 0, 1, '0–1', 0.05),
  S('Runners (curve coins taking off)', 'exit.stopLoss.maxPctByStrategy.RUNNER', 'Stop loss (max)', 5, 30, '%', 1),

  // ---- Bigger coins / KOL ----
  S('Bigger coins (swing) & KOL follow', 'trading.enabledStrategies.SWING', 'Swing on (1) / off (0)', 0, 1, undefined, 1),
  S('Bigger coins (swing) & KOL follow', 'trading.allocation.SWING', 'Swing share of the budget', 0, 1, '0–1', 0.05),
  S('Bigger coins (swing) & KOL follow', 'trading.maxOpenByStrategy.SWING', 'Swing max open', 0, 30, undefined, 1),
  S('Bigger coins (swing) & KOL follow', 'trading.enabledStrategies.SMART_MONEY_COPY', 'KOL follow on (1) / off (0)', 0, 1, undefined, 1),
  S('Bigger coins (swing) & KOL follow', 'trading.allocation.SMART_MONEY_COPY', 'KOL follow share of the budget', 0, 1, '0–1', 0.05),

  // ---- Every coin ----
  S('Every coin (safety & holders)', 'entry.minCombinedScore', 'Base score bar', 0, 100, 'pts', 1),
  S('Every coin (safety & holders)', 'entry.minSafetyScore', 'Min safety score', 0, 100, 'pts', 1),
  S('Every coin (safety & holders)', 'entry.maxTop10Pct', 'Max top-10 holders', 5, 100, '%', 1),
  S('Every coin (safety & holders)', 'entry.maxSingleHolderPct', 'Max one wallet holds', 1, 100, '%', 1),
  S('Every coin (safety & holders)', 'entry.maxDevHoldingPct', 'Max dev holds', 0, 100, '%', 1),
  S('Every coin (safety & holders)', 'entry.maxBundlePct', 'Max bundlers hold', 0, 100, '%', 1),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.maxTopDumpImpactPct', 'Rug guard: one holder could crash it', 10, 100, '%', 5),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.maxTop3DumpImpactPct', 'Rug guard: top-3 could crash it', 10, 100, '%', 5),

  // ---- Size & risk ----
  S('Trade size & risk', 'trading.maxPositionSol', 'Normal trade size', 0.01, 50, 'SOL', 0.05),
  S('Trade size & risk', 'trading.minPositionSol', 'Smallest trade', 0.01, 10, 'SOL', 0.01),
  S('Trade size & risk', 'trading.maxConcurrentPositions', 'Max trades open at once', 1, 100, undefined, 1),
  S('Trade size & risk', 'exit.stopLoss.minPct', 'Stop loss from', 5, 30, '%', 1),
  S('Trade size & risk', 'exit.stopLoss.maxPct', 'Stop loss up to', 5, 40, '%', 1),
];

/** Pure: read a dotted path from an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Pure: copy of `obj` with `path` set to `value` (creates missing objects). */
export function setPath<T extends Record<string, unknown>>(obj: T, path: string[], value: unknown): T {
  const copy = structuredClone(obj) as Record<string, unknown>;
  let node = copy;
  for (const k of path.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
  return copy as T;
}

/** Pure: validate a change. Booleans (enabledStrategies) are stored as true/false. */
export function checkEdit(key: string, raw: unknown): { ok: true; setting: EditableSetting; value: number | boolean } | { ok: false; error: string } {
  const setting = EDITABLE.find((x) => x.key === key);
  if (!setting) return { ok: false, error: 'That setting cannot be changed here' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: 'Not a number' };
  if (n < setting.min || n > setting.max) return { ok: false, error: `${setting.label}: must be ${setting.min}–${setting.max}` };
  return { ok: true, setting, value: key.startsWith('trading.enabledStrategies.') ? n >= 1 : n };
}
