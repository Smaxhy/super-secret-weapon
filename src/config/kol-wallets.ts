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

/**
 * The owner's own wallet picks (Oct 15: "if these wallets buy something it's often good, especially the last 8").
 * kind KOL = their buys count toward the KOL signal; weight ≥ kol.trustedMinWeight = a TRUSTED wallet (counts as 2 KOLs,
 * so one trusted buy already starts a KOL-follow check). Added once (marker `_ownerWallets1`); existing rows get the
 * higher weight. The owner also sent 0x… (EVM) addresses — not Solana, can't be tracked, left out.
 */
export const OWNER_PICKS: Array<{ address: string; top: boolean }> = [
  { address: 'Bi8gjp6g7hYmLJ2gsHbtdMwHyin4js1efTzDdJSQ6m4T', top: false },
  { address: 'mGbBx5GBee8gKj8Tr2YfuP18WnoGYEtkErtx6KgkdG1', top: false },
  { address: '3jckt69SiN3aCMbBWJoDS1s4xxGpqNxFFKnwhpRAQmuL', top: false },
  { address: 'JAunzNqs3bVBcWDjDxfq9rgLzJMCadNXoaCgfzLGMtYs', top: false },
  { address: 'DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam', top: false },
  { address: 'As7HjL7dzzvbRbaD3WCun47robib2kmAKRXMvjHkSMB5', top: false },
  { address: 'DuQabFqdC9eeBULVa7TTdZYxe8vK8ct5DZr4Xcf7docy', top: false },
  { address: '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t', top: false },
  { address: '9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL', top: false },
  // "especially the last 8" (the Solana ones among them)
  { address: '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG', top: true },
  { address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', top: true },
  { address: '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f', top: true },
  { address: '5B79fMkcFeRTiwm7ehsZsFiKsC7m7n1Bgv9yLxPp9q2X', top: true },
  { address: '8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6', top: true },
];
/** Owner: "you're allowed to copy trade him — if you're in a trade with him and he sells, sell instantly". kind COPY. */
export const OWNER_COPY_WALLETS = ['4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9'];

/** v15.4 (owner, Oct 18: "track this wallet, it's apparently a trustworthy wallet"): tracked as COPY (trusted weight) —
 *  copied only once the nightly copy test finds it consistent; until then its buys count as a trusted KOL signal. */
export const OWNER_TRUSTED_COPY = '5aLY85pyxiuX3fd4RgM3Yc1e3MAL6b7UgaZz6MS3JUfG';
export const PICK_WEIGHT = 1;
export const TOP_PICK_WEIGHT = 1.5;
