import { describe, it, expect } from 'vitest';
import { momentumGateFails, type MomentumGateConfig, type ShapeInput } from '../src/evaluator/momentum-gate';

const defaults: MomentumGateConfig = {
  enabled: true,
  maxRun1mPct: 25,
  maxRun3mPct: 40,
  minOffHighPct: 3,
  minBuyShare2m: 0.45,
  maxLastCandlePct: 20,
  skipForExplore: true,
  skipForDipEntry: true,
};

const good: ShapeInput = { run1m: 10, run3m: 20, offHigh10m: 8, buyShare2m: 0.6, lastCandlePct: 5 };

describe('momentum gate', () => {
  it('passes a healthy entry', () => {
    expect(momentumGateFails(good, defaults)).toBeNull();
  });

  it('disabled = always passes', () => {
    expect(momentumGateFails({ run1m: 100 }, { ...defaults, enabled: false })).toBeNull();
  });

  it('null shape = passes', () => {
    expect(momentumGateFails(null, defaults)).toBeNull();
  });

  it('blocks chasing — run1m too high', () => {
    const r = momentumGateFails({ ...good, run1m: 30 }, defaults);
    expect(r).toContain('chasing');
    expect(r).toContain('30%');
  });

  it('blocks chasing — run3m too high', () => {
    const r = momentumGateFails({ ...good, run3m: 50 }, defaults);
    expect(r).toContain('chasing');
    expect(r).toContain('50%');
  });

  it('blocks buying at the top — too close to the high', () => {
    const r = momentumGateFails({ ...good, offHigh10m: 1 }, defaults);
    expect(r).toContain('too close to the top');
  });

  it('passes when offHigh check is off (0)', () => {
    expect(momentumGateFails({ ...good, offHigh10m: 0 }, { ...defaults, minOffHighPct: 0 })).toBeNull();
  });

  it('blocks when sellers winning', () => {
    const r = momentumGateFails({ ...good, buyShare2m: 0.3 }, defaults);
    expect(r).toContain('sellers winning');
  });

  it('blocks buying the tip of a candle', () => {
    const r = momentumGateFails({ ...good, lastCandlePct: 25 }, defaults);
    expect(r).toContain('buying the tip');
  });

  it('checks run1m before run3m (order matters)', () => {
    const r = momentumGateFails({ ...good, run1m: 30, run3m: 50 }, defaults);
    expect(r).toContain('last minute');
  });

  it('handles missing shape fields gracefully', () => {
    expect(momentumGateFails({}, defaults)).toBeNull();
  });
});
