import { describe, expect, it } from 'vitest';
import { isHighConviction } from '../src/executor/trader';

const hc = { enabled: true, minScore: 80, minMarketCapUsd: 50_000 };
describe('high-conviction sizing (big trades only on strong setups)', () => {
  it('score 80+ on a normal trade → big size', () => expect(isHighConviction(hc, { score: 84 }, false, 1, 80_000)).toBe(true));
  it('score under 80 → normal size', () => expect(isHighConviction(hc, { score: 79.9 }, false, 1, 80_000)).toBe(false));
  it('learning, probe, half-size or losing strategy → normal size', () => {
    expect(isHighConviction(hc, { score: 90, explore: true }, false, 1, 80_000)).toBe(false);
    expect(isHighConviction(hc, { score: 90 }, true, 1, 80_000)).toBe(false);
    expect(isHighConviction(hc, { score: 90, sizeMultiplier: 0.5 }, false, 1, 80_000)).toBe(false);
    expect(isHighConviction(hc, { score: 90 }, false, 0.8, 80_000)).toBe(false);
  });
  it('low or unknown market cap → normal size', () => {
    expect(isHighConviction(hc, { score: 95 }, false, 1, 20_000)).toBe(false);
    expect(isHighConviction(hc, { score: 95 }, false, 1, null)).toBe(false);
  });
  it('switched off → never', () => expect(isHighConviction({ ...hc, enabled: false }, { score: 95 }, false, 1, 80_000)).toBe(false));
});
