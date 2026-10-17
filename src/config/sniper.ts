import { getConfig } from './runtime-config';

/**
 * Sniper mode (v11.7): few trades, full conviction, the owner's big size. While it's on, every learner that would
 * move the bar or the size (coach, calibration, autopsy tuning, allocator, win model, AI rules, entry styles, TA
 * bonus, timing, exit lab / tuner) keeps computing and logging but changes nothing — one switch, ten rules.
 */
export function sniperOn(): boolean {
  try {
    return (getConfig() as { sniper?: { enabled?: boolean } }).sniper?.enabled === true;
  } catch {
    return false; // config not loaded (tests)
  }
}
