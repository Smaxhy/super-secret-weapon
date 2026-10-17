import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { checkEdit, EDITABLE, getPath, setPath } from '../src/config/editable';

describe('editable controls', () => {
  it('every editable setting exists in the defaults with the right type', () => {
    const missing = EDITABLE.filter((e) => {
      const v = getPath(DEFAULT_CONFIG, e.key);
      const isBoolKey = e.key.startsWith('trading.enabledStrategies.') || e.key.endsWith('.enabled') || e.key.endsWith('.hideMayhem');
      if (isBoolKey) return typeof v !== 'boolean';
      if (typeof v === 'boolean') return false; // 0/1 toggles stored as boolean in defaults
      return typeof v !== 'number';
    }).map((e) => e.key);
    expect(missing).toEqual([]);
  });
  it('keys are unique', () => {
    expect(new Set(EDITABLE.map((e) => e.key)).size).toBe(EDITABLE.length);
  });
  it('checkEdit validates limits and converts on/off', () => {
    expect(checkEdit('nope.x', 1).ok).toBe(false);
    expect(checkEdit('focus.migrated.minMarketCapUsd', -1).ok).toBe(false);
    expect(checkEdit('focus.migrated.minMarketCapUsd', 'abc').ok).toBe(false);
    const r = checkEdit('focus.migrated.minMarketCapUsd', '30000');
    expect(r.ok && r.value).toBe(30000);
    const b = checkEdit('trading.enabledStrategies.SOON', 0);
    expect(b.ok && b.value).toBe(false);
  });
  it('setPath copies and sets nested values', () => {
    const o = { a: { b: 1, c: 2 } };
    const n = setPath(o, ['a', 'b'], 5);
    expect(n).toEqual({ a: { b: 5, c: 2 } });
    expect(o.a.b).toBe(1);
  });
});
