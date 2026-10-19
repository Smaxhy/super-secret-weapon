/**
 * v18.11 thin-coin learning probes (owner, data-collector mode: "crypto still isn't trading or learning"; Bot health:
 * 739 coins scored in an hour, 0 signals — New pair / Soon failed only "holders < N", "only N active wallets",
 * "liquidity N SOL < M"). Those rules say the coin is EARLY or SMALL, not that it is unsafe. A learning probe may take
 * such a coin at the MINIMUM size when nothing else is wrong: no safety hard fail, no rug / bundle / dumper /
 * deployer / owner-filter / momentum / chart failure, and the score within the learning margin. Pure helpers.
 */

/** Rules about size / age only — the ones a probe may ignore. Anything else keeps its full force. */
export const THIN_RULE = /^(holders \d+ < |only \d+ active wallets in 5m|liquidity [\d.]+ SOL < |volume \$|fees [\d.]+ SOL < )/;

export const thinRule = (fail: string): boolean => THIN_RULE.test(fail);

/** Every failed rule is a thin-coin rule (and there is at least one). */
export function thinOnly(fails: readonly string[]): boolean {
  return fails.length > 0 && fails.every(thinRule);
}

/** A sliding one-hour counter (pure in effect: pass `now`). */
export class HourWindow {
  private readonly at: number[] = [];
  constructor(readonly max: number) {}
  /** May one more go now? Records it when yes. */
  take(now: number): boolean {
    while (this.at.length && now - this.at[0]! > 3_600_000) this.at.shift();
    if (this.at.length >= this.max) return false;
    this.at.push(now);
    return true;
  }
  count(now: number): number {
    return this.at.filter((t) => now - t <= 3_600_000).length;
  }
}
