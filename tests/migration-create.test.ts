import { describe, expect, it } from 'vitest';
import { applyMigration, MIGRATIONS } from '../src/config/migrations';

describe('config migrations: create missing sections', () => {
  it('skips unsaved sections without create, writes them with create', () => {
    const m = { version: 999, note: 't', set: [['sniper', ['enabled'], false]] as Array<[string, string[], unknown]> };
    expect(applyMigration({}, m)).toEqual({});
    expect(applyMigration({}, { ...m, create: true })).toEqual({ sniper: { enabled: false } });
  });
  it('v54 turns Sniper mode and the meme reader off even when never saved', () => {
    const v54 = MIGRATIONS.find((x) => x.version === 54)!;
    const out = applyMigration({ trading: { maxPositionSol: 0.5 } }, v54);
    expect(out.sniper).toEqual({ enabled: false });
    expect(out.meme).toEqual({ enabled: false });
    expect((out.trading as { maxPositionSol: number }).maxPositionSol).toBe(0.2);
    expect((out.chart as { dip: { dipOnly: { enabled: boolean } } }).dip.dipOnly.enabled).toBe(false);
  });
});
