/**
 * Seed script — run with `npm run db:seed`.
 *
 * Writes the default config into BotConfig (only for keys that don't exist
 * yet, so it never overwrites changes you made from the dashboard) and loads
 * any known scam wallets into the blacklist.
 */
import { DEFAULT_CONFIG } from '../config/default';
import { prisma } from '../lib/prisma';

/**
 * Known bad actors. Add addresses here (or later from the dashboard) as you
 * find serial ruggers. Intentionally empty — never trust a random list off
 * the internet without checking the wallets yourself on Solscan.
 */
const KNOWN_SCAM_WALLETS: Array<{ address: string; reason: string }> = [];

async function main(): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    await prisma.botConfig.upsert({
      where: { key },
      update: {}, // keep existing values
      create: { key, value: value as object },
    });
  }
  console.log(`✔ config keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}`);

  for (const w of KNOWN_SCAM_WALLETS) {
    await prisma.blacklist.upsert({
      where: { address: w.address },
      update: {},
      create: { address: w.address, type: 'CREATOR', reason: w.reason },
    });
  }
  console.log(`✔ blacklist entries: ${KNOWN_SCAM_WALLETS.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
