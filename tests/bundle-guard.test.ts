import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { holderBundleVerdict, sameDayGroup, sameSizeGroup, type BundleHolder, type WalletBirth } from '../src/executor/rug-watch';
import { rugScreen } from '../src/executor/rug-screen';

const c = DEFAULT_CONFIG.antiRug.rugGuard.bundle;
const SUPPLY = 1e15;
const pct = (p: number) => (p / 100) * SUPPLY;
const NOW = 1_800_000_000;
const DAY = 86_400;

/** A natural-looking holder list: Zipf-ish balances (3% / rank), each a bit different. */
function natural(n: number): BundleHolder[] {
  return Array.from({ length: n }, (_, k) => ({ w: `n${k}`, amt: pct(3 / (k + 1)) }));
}

describe('bundle guard', () => {
  it('flags many top holders with the same ~0.5% (the owner case)', () => {
    const bundle = Array.from({ length: 14 }, (_, k) => ({ w: `b${k}`, amt: pct(0.5 * (1 + (k % 3) * 0.01)) }));
    const why = holderBundleVerdict([...natural(8), ...bundle], SUPPLY, [], NOW, c);
    expect(why).toMatch(/bundle: 1[45] wallets hold the same ~0\.5\d% each/);
  });

  it('flags top holders whose wallets were all made the same day months ago', () => {
    const holders = natural(15);
    const births: WalletBirth[] = holders.map((h, k) => ({ w: h.w, bornSec: k < 6 ? NOW - 150 * DAY + k * 600 : NOW - (30 + k * 40) * DAY }));
    expect(holderBundleVerdict(holders, SUPPLY, births, NOW, c)).toMatch(/6 top holders' wallets were made the same day \(150 days ago\)/);
  });

  it('flags a few same-size wallets that share a birthday', () => {
    const trio = [0.8, 0.81, 0.805].map((p, k) => ({ w: `t${k}`, amt: pct(p) }));
    const holders = [...natural(10), ...trio];
    const births: WalletBirth[] = trio.map((h, k) => ({ w: h.w, bornSec: NOW - 90 * DAY + k * 3600 }));
    expect(holderBundleVerdict(holders, SUPPLY, births, NOW, c)).toMatch(/3 wallets made the same day \(90 days ago\) hold the same/);
  });

  it('leaves a natural holder list alone (no same-size group, spread-out wallet ages)', () => {
    const holders = natural(30);
    const births: WalletBirth[] = holders.map((h, k) => ({ w: h.w, bornSec: NOW - (5 + k * 23) * DAY }));
    expect(holderBundleVerdict(holders, SUPPLY, births, NOW, c)).toBeNull();
    expect((sameSizeGroup(holders, SUPPLY, c)?.wallets.length ?? 0)).toBeLessThan(c.sameSizeMinWallets);
  });

  it('ignores fresh wallets made today (the funding graph handles those) and dust holders', () => {
    const fresh: WalletBirth[] = Array.from({ length: 8 }, (_, k) => ({ w: `f${k}`, bornSec: NOW - 3600 - k * 60 }));
    expect(sameDayGroup(fresh, NOW, c)).toBeNull();
    const dust = Array.from({ length: 20 }, (_, k) => ({ w: `d${k}`, amt: pct(0.05) }));
    expect(holderBundleVerdict([...natural(10), ...dust], SUPPLY, [], NOW, c)).toBeNull();
  });

  it('can be switched off and refuses the buy through the rug screen', () => {
    const bundle = Array.from({ length: 10 }, (_, k) => ({ w: `b${k}`, amt: pct(0.5) }));
    expect(holderBundleVerdict(bundle, SUPPLY, [], NOW, { ...c, enabled: false })).toBeNull();
    const snap = { devHoldingPct: 0, devSoldFraction: 0, earlyBuyerPct: 0, top10HolderPct: 10, liquiditySol: 50, priceSol: 1e-7 };
    const why = holderBundleVerdict(bundle, SUPPLY, [], NOW, c);
    expect(rugScreen({ atSignal: snap, now: snap, onAmm: false, flow60s: null, insider: null, maxDevHoldingPct: 10, bundle: why })).toBe(why);
  });
});
