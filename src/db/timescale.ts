/**
 * TimescaleDB setup — run automatically at boot, safe to run any number of times.
 *
 * Prisma creates normal Postgres tables. This turns `TokenSnapshot` into a
 * Timescale hypertable (auto-partitioned into 1-day chunks) and adds:
 *   - compression for chunks older than 7 days (~10x smaller),
 *   - retention: raw snapshots are dropped after 30 days,
 *   - two continuous aggregates that are kept FOREVER:
 *       token_daily_outcomes  one row per token per day (peak MC, max holders,
 *                             did it complete) — the long-term ML labels
 *       market_daily_stats    one row per day per snapshot interval — market trends
 *
 * If the Timescale extension isn't installed (e.g. plain Postgres on your
 * laptop) we log a warning and carry on: everything still works, you just
 * don't get compression/retention.
 *
 * Each statement runs on its own because continuous aggregates can't be
 * created inside a transaction.
 */
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('timescale');

const STATEMENTS: Array<{ name: string; sql: string }> = [
  {
    name: 'hypertable',
    sql: `SELECT create_hypertable('"TokenSnapshot"', 'takenAt',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE, migrate_data => TRUE, create_default_indexes => FALSE)`,
  },
  {
    name: 'compression settings',
    sql: `ALTER TABLE "TokenSnapshot" SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'mint',
            timescaledb.compress_orderby = '"takenAt" DESC')`,
  },
  {
    name: 'compression policy',
    sql: `SELECT add_compression_policy('"TokenSnapshot"', INTERVAL '7 days', if_not_exists => TRUE)`,
  },
  {
    name: 'retention policy',
    sql: `SELECT add_retention_policy('"TokenSnapshot"', INTERVAL '30 days', if_not_exists => TRUE)`,
  },
  {
    name: 'token_daily_outcomes',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS token_daily_outcomes
          WITH (timescaledb.continuous) AS
          SELECT time_bucket(INTERVAL '1 day', "takenAt") AS day,
                 mint,
                 max("marketCapSol")    AS peak_mc_sol,
                 max("holderCount")     AS max_holders,
                 max("bondingCurvePct") AS max_curve_pct,
                 max("volumeSol")       AS volume_sol,
                 bool_or("isComplete")  AS completed,
                 max("devHoldingPct")   AS max_dev_pct,
                 max("top10HolderPct")  AS max_top10_pct,
                 count(*)               AS snapshots
          FROM "TokenSnapshot"
          GROUP BY day, mint
          WITH NO DATA`,
  },
  {
    name: 'token_daily_outcomes policy',
    sql: `SELECT add_continuous_aggregate_policy('token_daily_outcomes',
            start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)`,
  },
  {
    name: 'market_daily_stats',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS market_daily_stats
          WITH (timescaledb.continuous) AS
          SELECT time_bucket(INTERVAL '1 day', "takenAt") AS day,
                 "interval",
                 count(*)                                       AS tokens,
                 avg("holderCount")                             AS avg_holders,
                 avg("marketCapSol")                            AS avg_mc_sol,
                 avg(CASE WHEN "isComplete" THEN 1.0 ELSE 0.0 END) AS completion_rate,
                 avg("devHoldingPct")                           AS avg_dev_pct
          FROM "TokenSnapshot"
          GROUP BY day, "interval"
          WITH NO DATA`,
  },
  {
    name: 'market_daily_stats policy',
    sql: `SELECT add_continuous_aggregate_policy('market_daily_stats',
            start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)`,
  },
];

/** Errors that just mean "already done" — fine to ignore on re-runs. */
const ALREADY_DONE = /already|exists|compressed chunks/i;

export async function ensureTimescale(): Promise<boolean> {
  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS timescaledb');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'TimescaleDB extension not available — running on plain Postgres (no compression/retention)');
    return false;
  }

  for (const s of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(s.sql);
      log.debug(`timescale: ${s.name} ok`);
    } catch (err) {
      const msg = (err as Error).message;
      if (ALREADY_DONE.test(msg)) log.debug(`timescale: ${s.name} already set up`);
      else log.warn({ err: msg }, `timescale: ${s.name} failed`);
    }
  }
  log.info('TimescaleDB ready (hypertable, compression, 30d retention, daily aggregates)');
  return true;
}
