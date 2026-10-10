/**
 * Saved-settings migrations.
 *
 * Every config section saved in the database (seed script, or the Controls page
 * writing a whole section) wins over the code defaults, so a changed default
 * never reaches an existing install on its own. Each migration below sets a few
 * specific settings — only the ones a change deliberately moves — in the saved
 * rows. Everything else the owner set stays untouched. Applied once, in order;
 * the applied version is stored in the BotConfig row `_version`.
 */
import type { Prisma } from '@prisma/client';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('config-migrations');
export const VERSION_KEY = '_version';

export interface ConfigMigration {
  version: number;
  note: string;
  /** [section, path inside the section, new value] */
  set: Array<[string, string[], unknown]>;
}

export const MIGRATIONS: ConfigMigration[] = [
  {
    version: 1,
    note: 'break-even stop from 1.2x, trail from 1.2x, copy trades restricted, crowd log for every coin',
    set: [
      ['exit', ['trail', 'breakEvenAfterMultiple'], 1.2],
      ['exit', ['trailingStopActivateMultiple'], 1.2],
      ['trading', ['allocation', 'SMART_MONEY_COPY'], 0.05],
      ['copy', ['scoreThresholdDelta'], 5],
      ['focus', ['crowdLogFromCurvePct'], 0],
    ],
  },
  {
    version: 2,
    note: 'stricter, instant trailing stop; faster paper fills (150–500 ms)',
    set: [
      ['exit', ['trailingStopActivateMultiple'], 1.15],
      ['exit', ['trail', 'confirmTicks'], 1],
      ['exit', ['trail', 'confirmSec'], 0],
      ['exit', ['trail', 'ladder'], [
        { fromMultiple: 1.15, pct: 6 },
        { fromMultiple: 1.3, pct: 7 },
        { fromMultiple: 1.5, pct: 9 },
        { fromMultiple: 2, pct: 11 },
        { fromMultiple: 3, pct: 14 },
        { fromMultiple: 5, pct: 17 },
        { fromMultiple: 10, pct: 20 },
      ]],
      ['exit', ['trail', 'volAdjust'], { min: 0.8, max: 1.15 }],
      ['paper', ['latencyMinMs'], 150],
      ['paper', ['latencyMaxMs'], 500],
    ],
  },
  {
    version: 3,
    note: 'dip buy zone starts 10–15% below the high and follows new highs; watch until +100% from the signal',
    set: [
      ['chart', ['dip', 'zoneTopMaxPct'], 15],
      ['chart', ['dip', 'runAwayPct'], 100],
    ],
  },
  {
    version: 4,
    note: 'v5 strategy (research): new pairs first, copy trading off, winners pay for losers (40% at 1.4x, wide trail, time stops), late-curve / BOOST-window entries cut',
    set: [
      ['trading', ['allocation'], { CURVE_SNIPE: 0.55, MIGRATION_MOMENTUM: 0.25, SOON: 0.2, SMART_MONEY_COPY: 0 }],
      ['trading', ['enabledStrategies', 'SMART_MONEY_COPY'], false],
      ['exit', ['takeProfitTiers'], [{ multiple: 1.4, sellPct: 40 }, { multiple: 5, sellPct: 15 }]],
      ['exit', ['trailingStopActivateMultiple'], 1.4],
      ['exit', ['trail', 'confirmSec'], 0.5],
      ['exit', ['trail', 'breakEvenAfterMultiple'], 1.4],
      ['exit', ['trail', 'ladder'], [
        { fromMultiple: 1.4, pct: 20 },
        { fromMultiple: 2, pct: 25 },
        { fromMultiple: 3, pct: 25 },
        { fromMultiple: 5, pct: 22 },
        { fromMultiple: 10, pct: 20 },
      ]],
      ['exit', ['trail', 'volAdjust'], { min: 0.8, max: 1.2 }],
      ['exit', ['trail', 'peakHoldMs'], 2500],
      ['exit', ['protectProfit'], { afterMultiple: 1.4, floorMultiple: 1.03 }],
      ['exit', ['resistance', 'minProfitMultiple'], 1.5],
      ['exit', ['riskExit', 'minProfitMultiple'], 1.5],
      ['exit', ['maxHoldMinutes'], { CURVE_SNIPE: 30, SOON: 45, MIGRATION_MOMENTUM: 240, SMART_MONEY_COPY: 60 }],
      ['exit', ['stopLoss', 'minPct'], 12],
      ['exit', ['stopLoss', 'confirmSec'], 2],
      ['exit', ['staleMinutes'], { CURVE_SNIPE: 20, SOON: 20, MIGRATION_MOMENTUM: 60, SMART_MONEY_COPY: 60 }],
      ['focus', ['soon', 'maxCurvePct'], 90],
      ['focus', ['soon', 'minMarketCapUsd'], 0],
      ['focus', ['soon', 'minVolumeUsd'], 10_000],
      ['focus', ['soon', 'scoreThresholdDelta'], 0],
      ['focus', ['soon', 'sizeMultiplier'], 1],
      ['focus', ['migrated', 'scoreThresholdDelta'], 0],
      ['focus', ['migrated', 'sizeMultiplier'], 1],
      ['focus', ['swing', 'maxReentries'], 1],
      ['scoring', ['checkpointsSec'], [45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720]],
      ['scoring', ['migrationCheckpointsSec'], [330, 480, 660, 900, 1200, 1800, 2400, 3600]],
      ['chart', ['smartSell', 'minMultiple'], 1.6],
    ],
  },
  {
    version: 5,
    note: 'v7 (owner: swing more, especially bigger coins; trade more often to learn): SWING strategy (30% of capital, max 3 open), up to 8 positions, a little looser new-pair demand rules',
    set: [
      ['trading', ['allocation'], { CURVE_SNIPE: 0.4, MIGRATION_MOMENTUM: 0.15, SOON: 0.15, SMART_MONEY_COPY: 0, SWING: 0.3 }],
      ['trading', ['enabledStrategies', 'SWING'], true],
      ['trading', ['maxConcurrentPositions'], 8],
      ['trading', ['maxOpenByStrategy'], { CURVE_SNIPE: 4, SOON: 2, MIGRATION_MOMENTUM: 2, SMART_MONEY_COPY: 1, SWING: 3 }],
      ['focus', ['newPair', 'minBuyers60s'], 10],
      ['focus', ['newPair', 'minNewBuyers60s'], 6],
      ['focus', ['newPair', 'minNetFlowSol60s'], 1],
      ['focus', ['newPair', 'minBuyRatioSol'], 1.2],
      ['focus', ['newPair', 'minBuyRatioCount'], 1.3],
      ['focus', ['newPair', 'maxGapSec'], 20],
    ],
  },
  {
    version: 6,
    note: 'v8 (owner: be very strict with swings, take 10% profits fast, sell spikes, bigger size on bigger coins; avoid vamps)',
    set: [
      ['swing', ['minMarketCapUsd'], 50_000],
      ['swing', ['minLiquidityUsd'], 25_000],
      ['swing', ['minVolume24hUsd'], 250_000],
      ['swing', ['minPullbackPct'], 15],
      ['swing', ['maxPullbackPct'], 35],
      ['swing', ['maxBouncePct'], 8],
      ['swing', ['minBuyRatio'], 1.3],
      ['swing', ['minTrades10m'], 40],
      ['swing', ['maxDrop1hPct'], 30],
      ['swing', ['blockDowntrend'], true],
      ['swing', ['minScore'], 78],
      ['swing', ['watchlistScoreDelta'], -3],
      ['swing', ['minResilience'], 0.45],
      ['swing', ['maxTop10Pct'], 45],
      ['swing', ['halfSizeTop10Pct'], 35],
      ['swing', ['reentryCooldownMin'], 30],
      ['swing', ['lossCooldownMin'], 240],
      ['swing', ['maxTradesPerCoinPerDay'], 3],
      ['swing', ['lossStreakPauseHours'], 48],
      ['trading', ['maxPositionMultipleByStrategy', 'SWING'], 2.5],
      ['exit', ['byStrategy', 'SWING'], {
        takeProfitTiers: [{ multiple: 1.1, sellPct: 50 }, { multiple: 1.2, sellPct: 25 }, { multiple: 1.5, sellPct: 15 }],
        trailingStopActivateMultiple: 1.1,
        trail: { breakEvenAfterMultiple: 1.1, ladder: [{ fromMultiple: 1.1, pct: 6 }, { fromMultiple: 1.2, pct: 7 }, { fromMultiple: 1.5, pct: 9 }, { fromMultiple: 2, pct: 12 }], peakHoldMs: 2000 },
        protectProfit: { afterMultiple: 1.08, floorMultiple: 1.02 },
        timeStop: { minPeakMultiple: 1.04, maxMultiple: 1.0 },
        spikeSell: { enabled: true, risePct: 8, windowSec: 120, sellPct: 50, minMultiple: 1.04 },
        holdLonger: { enabled: true, minMarketCapUsd: 60_000, maxHours: 8 },
      }],
      ['exit', ['timeStop', 'minutes', 'SWING'], 30],
      ['exit', ['timeStop', 'stallMinutes', 'SWING'], 45],
      ['exit', ['maxHoldMinutes', 'SWING'], 240],
      ['exit', ['staleMinutes', 'SWING'], 45],
      ['exit', ['stopLoss', 'maxPctByStrategy', 'SWING'], 12],
      ['exit', ['stopLoss', 'minPctByStrategy', 'SWING'], 10],
      ['explore', ['scoreMargin'], 5],
      ['explore', ['strategies'], ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM']],
    ],
  },
];

/** BotConfig row: the time the current strategy version went live (learning that reads our own trades starts here). */
export const STRATEGY_SINCE_KEY = '_strategySince';
const UPGRADES_KEY = '_upgrades';

/** Run a one-time step once per database (recorded in the `_upgrades` row). Never throws. */
export async function oneTimeUpgrade(id: string, step: () => Promise<void>): Promise<boolean> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: UPGRADES_KEY } });
    const done = ((row?.value as { done?: string[] } | null)?.done ?? []).slice();
    if (done.includes(id)) return false;
    await step();
    done.push(id);
    await prisma.botConfig.upsert({ where: { key: UPGRADES_KEY }, update: { value: { done } }, create: { key: UPGRADES_KEY, value: { done } } });
    log.info({ id }, 'one-time upgrade applied');
    return true;
  } catch (err) {
    log.warn({ id, err: (err as Error).message }, 'one-time upgrade failed — will retry next start');
    return false;
  }
}

/** Mark "the current strategy starts now" (used by the strategy cool-off breaker). */
export async function markStrategySince(at = new Date()): Promise<void> {
  await prisma.botConfig.upsert({ where: { key: STRATEGY_SINCE_KEY }, update: { value: { at: at.toISOString() } }, create: { key: STRATEGY_SINCE_KEY, value: { at: at.toISOString() } } });
}

let sinceCache: { at: number; value: Date | null } | null = null;
/** When the current strategy went live (cached 5 min). null = unknown (count everything). */
export async function strategySince(): Promise<Date | null> {
  if (sinceCache && Date.now() - sinceCache.at < 300_000) return sinceCache.value;
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: STRATEGY_SINCE_KEY } });
    const iso = (row?.value as { at?: string } | null)?.at;
    sinceCache = { at: Date.now(), value: iso ? new Date(iso) : null };
  } catch {
    sinceCache = { at: Date.now(), value: null };
  }
  return sinceCache.value;
}

/** Pure: apply `set` to saved rows. Returns only the rows that changed (sections never saved are skipped). */
export function applyMigration(rows: Record<string, unknown>, m: ConfigMigration): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [section, path, value] of m.set) {
    const base = changed[section] ?? rows[section];
    if (!base || typeof base !== 'object' || Array.isArray(base)) continue;
    const copy = structuredClone(base) as Record<string, unknown>;
    let node = copy;
    for (const k of path.slice(0, -1)) {
      const next = node[k];
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        node[k] = {};
      }
      node = node[k] as Record<string, unknown>;
    }
    node[path[path.length - 1]!] = value;
    changed[section] = copy;
  }
  return changed;
}

/** Run pending migrations against the database. Never throws (logs instead). */
export async function runConfigMigrations(list: readonly ConfigMigration[] = MIGRATIONS): Promise<number> {
  try {
    const rows = await prisma.botConfig.findMany();
    const saved: Record<string, unknown> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let version = Number((saved[VERSION_KEY] as { version?: number } | undefined)?.version ?? 0);
    let applied = 0;
    for (const m of list) {
      if (m.version <= version) continue;
      const changed = applyMigration(saved, m);
      for (const [key, value] of Object.entries(changed)) {
        await prisma.botConfig.update({ where: { key }, data: { value: value as Prisma.InputJsonValue } });
        saved[key] = value;
      }
      version = m.version;
      await prisma.botConfig.upsert({ where: { key: VERSION_KEY }, update: { value: { version } }, create: { key: VERSION_KEY, value: { version } } });
      applied++;
      log.info({ version, sections: Object.keys(changed) }, `saved settings migrated: ${m.note}`);
    }
    return applied;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'config migrations failed — keeping saved settings as they are');
    return 0;
  }
}
