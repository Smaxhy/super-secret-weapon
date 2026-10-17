import { describe, it, expect } from 'vitest';
import { earlyBailReason, DEFAULT_EARLY_BAIL, type EarlyBailInput, type EarlyBailConfig } from '../src/executor/early-bail';

const cfg = DEFAULT_EARLY_BAIL; // enabled, maxSec 45, minPeakMultiple 1.02, maxBuyRatio 1.0

describe('earlyBailReason', () => {
  it('returns null when disabled', () => {
    expect(earlyBailReason({ heldSec: 20, peakMultiple: 1.0, buyRatio: 0.5, multiple: 0.95 }, { ...cfg, enabled: false })).toBeNull();
  });

  it('returns null before 10 seconds (too early to judge)', () => {
    expect(earlyBailReason({ heldSec: 5, peakMultiple: 1.0, buyRatio: 0.5, multiple: 0.95 }, cfg)).toBeNull();
  });

  it('returns null after maxSec (normal time stops handle it)', () => {
    expect(earlyBailReason({ heldSec: 50, peakMultiple: 1.0, buyRatio: 0.5, multiple: 0.95 }, cfg)).toBeNull();
  });

  it('returns null when the trade showed life (peak >= 1.02x)', () => {
    expect(earlyBailReason({ heldSec: 30, peakMultiple: 1.03, buyRatio: 0.5, multiple: 0.97 }, cfg)).toBeNull();
  });

  it('returns null when still above entry (multiple >= 1)', () => {
    expect(earlyBailReason({ heldSec: 30, peakMultiple: 1.01, buyRatio: 0.5, multiple: 1.0 }, cfg)).toBeNull();
  });

  it('returns null when buyers are winning (buyRatio > 1.0)', () => {
    expect(earlyBailReason({ heldSec: 30, peakMultiple: 1.01, buyRatio: 1.5, multiple: 0.95 }, cfg)).toBeNull();
  });

  it('fires on a dead trade: 25s in, no life, sellers winning', () => {
    const reason = earlyBailReason({ heldSec: 25, peakMultiple: 1.005, buyRatio: 0.6, multiple: 0.94 }, cfg);
    expect(reason).not.toBeNull();
    expect(reason).toContain('dead on arrival');
  });

  it('fires at the boundary: exactly 10s, exactly below thresholds', () => {
    const reason = earlyBailReason({ heldSec: 10, peakMultiple: 1.019, buyRatio: 0.99, multiple: 0.999 }, cfg);
    expect(reason).not.toBeNull();
  });

  it('fires at maxSec boundary (exactly 45s)', () => {
    const reason = earlyBailReason({ heldSec: 45, peakMultiple: 1.0, buyRatio: 0.5, multiple: 0.90 }, cfg);
    expect(reason).not.toBeNull();
  });

  it('does NOT fire when buyRatio is null (no flow data — replays and virtual trades): flat is not dead', () => {
    const reason = earlyBailReason({ heldSec: 30, peakMultiple: 1.01, buyRatio: null, multiple: 0.95 }, cfg);
    expect(reason).toBeNull();
  });

  it('respects custom config values', () => {
    const custom: EarlyBailConfig = { enabled: true, maxSec: 60, minPeakMultiple: 1.05, maxBuyRatio: 1.2 };
    // Would not fire with defaults (peak 1.03 > default 1.02) but fires with custom (1.03 < 1.05)
    const reason = earlyBailReason({ heldSec: 50, peakMultiple: 1.03, buyRatio: 1.1, multiple: 0.98 }, custom);
    expect(reason).not.toBeNull();
  });

  it('edge: buyRatio exactly at the limit (1.0) still fires', () => {
    const reason = earlyBailReason({ heldSec: 20, peakMultiple: 1.01, buyRatio: 1.0, multiple: 0.95 }, cfg);
    expect(reason).not.toBeNull();
  });
});
