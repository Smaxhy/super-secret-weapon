/**
 * Starter KOL list — public wallets of well-known Solana memecoin traders.
 *
 * Seeded once into the Wallets page as kind KOL (you can edit / remove them;
 * removed ones are not re-added). Addresses come from public KOL trackers and
 * can be outdated or mislabelled — check each on kolscan.io / gmgn.ai and add
 * more with the bulk import on the Wallets page.
 */
export interface KnownKol {
  name: string;
  address: string;
  /** Where the address came from (shown as the wallet's notes). */
  source: string;
  /** How much its buys count (0-1). Lower for weakly sourced addresses. */
  weight: number;
}

export const KNOWN_KOLS: KnownKol[] = [
  { name: 'Cupsey', address: '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f', source: 'public KOL trackers (kolexplorer.com, uwuu.ai) — verify on kolscan', weight: 1 },
  { name: 'Cented', address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', source: 'public KOL tracker (kolexplorer.com) — verify on kolscan', weight: 1 },
  { name: 'Orangie', address: '96sErVjEN7LNJ6Uvj63bdRWZxNuBngj56fnT9biHLKBf', source: 'older public wallet list (~2024) — may be outdated, verify on kolscan', weight: 0.5 },
];
