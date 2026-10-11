/**
 * Apply one owner-editable setting (config/editable.ts) — used by the Controls page (PUT /api/controls/rules) and by
 * the AI coach when the owner's tip asks for a setting change. Every change goes into "What the bot changed".
 */
import { recordChange } from '../lib/change-log';
import { checkEdit, getPath, setPath } from './editable';
import { getConfig, updateConfigSection } from './runtime-config';

export async function applyEdit(key: string, raw: unknown, source: 'owner' | 'owner-tip', why: string): Promise<{ ok: true; text: string; value: unknown } | { ok: false; error: string }> {
  const r = checkEdit(key, raw);
  if (!r.ok) return r;
  const [section, ...rest] = key.split('.') as [keyof ReturnType<typeof getConfig>, ...string[]];
  const before = getPath(getConfig(), key);
  let next = setPath(getConfig()[section] as Record<string, unknown>, rest, r.value);
  // A bigger normal size raises the safety ceiling with it (otherwise the ceiling silently caps it).
  if (key === 'trading.maxPositionSol') next = { ...next, maxPositionSolCeiling: Math.max(Number((next as { maxPositionSolCeiling?: number }).maxPositionSolCeiling ?? 0), r.value as number) };
  await updateConfigSection(section as never, next as never);
  const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
  const text = `${r.setting.group}: ${r.setting.label} ${show(before)} → ${show(r.value)}`;
  void recordChange({ source, strategy: null, what: text, why });
  return { ok: true, text, value: getPath(getConfig(), key) };
}
