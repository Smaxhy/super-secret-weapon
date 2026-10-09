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
];

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
