/**
 * Bot health: is the bot restarting, why did it last stop, is the VPS running
 * the newest code? Banner (Overview) + full panel (Scanner page).
 */
import { useApi } from '../hooks/useApi';
import { duration, STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { Card } from './ui';

interface SystemData {
  version: string;
  startedAt: string;
  uptimeSec: number;
  eventLoopLagMs: number | null;
  restarts24h: number | null;
  /** Restarts after a crash / kill (updates not counted). Older bots don't send it. */
  crashes24h?: number | null;
  lastExit: { at: string; reason: string } | null;
  recentErrors: Array<{ at: string; message: string }>;
  memory: { rssMb: number; heapMb: number };
  redisMemoryMb: number | null;
  /** v11.5: the tape recorder (replay engine recording). */
  tape?: { enabled: boolean; perMin: number; buffered: number; written: number; dropped: number; failed: number; daysOnDisk: number | null; rowsOnDisk: number | null } | null;
  trading?: {
    lastEntryAt: string | null;
    minutesSinceEntry: number;
    lastHour: { evaluated: number; buySignals: number; entries: number };
    topSkips: Array<{ reason: string; count: number }>;
    topRefusals: Array<{ reason: string; count: number }>;
    /** v10.33: per-strategy funnel (older bots don't send it). */
    strategies?: StrategyFunnel[];
    summary: string;
  };
}

interface StrategyFunnel {
  strategy: string;
  on: boolean | null;
  checked: number;
  rulesOk: number;
  signal: number;
  dipWait: number;
  confirming: number;
  notConfirmed: number;
  heldBack: number;
  toTrader: number;
  refused: number;
  bought: number;
  dipGaveUp: number;
  /** Its own top skip reasons (newer bots). */
  topSkips?: Array<{ reason: string; count: number }>;
}

/** Commit the website was built from (GitHub Actions sets GITHUB_SHA). */
export const SITE_VERSION = (import.meta.env.VITE_GIT_SHA ?? '').slice(0, 7) || 'dev';

// (the site only rebuilds when the dashboard changes, so a different site version is normal — the real
// "is the bot behind" answer is the auto-updater's: newest commit on GitHub vs what the bot runs)
const versionMismatch = (bot: string) => bot !== 'dev' && bot !== 'unknown' && SITE_VERSION !== 'dev' && bot !== SITE_VERSION;
interface UpdateInfo { running: string; last: { state: string; remote: string } | null }
const botBehind = (u: UpdateInfo | null | undefined) => !!u?.last?.remote && u.running !== 'dev' && u.last.remote !== u.running;
const crashed = (r: string | undefined) => !!r && /killed|crash/i.test(r);

/** Short warning on the Overview when something is off (renders nothing when healthy). */
export function HealthBanner() {
  const { data } = useApi<SystemData>('/api/system', 60_000);
  const { data: upd } = useApi<UpdateInfo>('/api/update', 120_000);
  if (!data) return null;
  const issues: string[] = [];
  // Every update restarts the bot — only crashes are a problem.
  if (data.crashes24h != null) {
    if (data.crashes24h >= 3) issues.push(`the bot crashed ${data.crashes24h}× in 24h`);
  } else if ((data.restarts24h ?? 0) >= 3) issues.push(`the bot restarted ${data.restarts24h}× in 24h (updates included)`);
  if (crashed(data.lastExit?.reason) && data.uptimeSec < 3600) issues.push(`last stop: ${data.lastExit!.reason}`);
  if (botBehind(upd) && data.uptimeSec > 20 * 60) issues.push(`the VPS runs older code (${data.version}) than GitHub (${upd!.last!.remote}) — its update may be stuck`);
  if ((data.eventLoopLagMs ?? 0) > 1000) issues.push(`the bot is overloaded (${data.eventLoopLagMs} ms lag)`);
  if (data.trading && data.trading.minutesSinceEntry >= 30 && data.uptimeSec > 10 * 60) issues.push(`no buy for ${duration(data.trading.minutesSinceEntry * 60)}: ${data.trading.summary}`);
  if (!issues.length) return null;
  return (
    <div role="status" className="mb-4 flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm text-ink">
      <Icon name="alert" size={18} className="mt-px text-warning" />
      <div className="min-w-0">
        <div className="font-semibold">Bot health</div>
        <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-ink-2">
          {issues.map((x) => (
            <li key={x} className="break-words">{x}</li>
          ))}
        </ul>
        <p className="mt-1.5 text-xs text-muted">
          Details: Scanner → Health. Update button: Controls → System. On the VPS: <code className="break-all">bash /root/bot/scripts/diagnose.sh</code>
        </p>
      </div>
    </div>
  );
}

export function SystemPanel() {
  const { data, error } = useApi<SystemData>('/api/system', 30_000);
  const { data: upd } = useApi<UpdateInfo>('/api/update', 120_000);
  return (
    <Card title="Bot health">
      {error && <p className="text-sm text-down">{error}</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Running for" value={duration(data.uptimeSec)} />
            <Stat label="Restarts (24h)" value={data.restarts24h ?? '—'} warn={data.crashes24h != null ? data.crashes24h >= 3 : (data.restarts24h ?? 0) >= 3} sub={data.crashes24h != null ? `${data.crashes24h} crash${data.crashes24h === 1 ? '' : 'es'}, rest = updates` : undefined} />
            <Stat label="Memory" value={`${data.memory.rssMb} MB`} sub={data.redisMemoryMb !== null ? `Redis ${data.redisMemoryMb} MB` : undefined} />
            <Stat label="Lag" value={data.eventLoopLagMs !== null ? `${data.eventLoopLagMs} ms` : '—'} warn={(data.eventLoopLagMs ?? 0) > 1000} />
            <Stat label="Bot version" value={data.version} warn={botBehind(upd)} sub={botBehind(upd) ? `newest ${upd!.last!.remote}` : versionMismatch(data.version) ? `up to date (site ${SITE_VERSION})` : 'up to date'} />
          </div>
          {data.tape && (
            <p className={`mt-3 text-xs ${data.tape.enabled ? (data.tape.failed > 0 && data.tape.written === 0 ? 'text-down' : 'text-muted') : 'text-muted'}`}>
              Tape: {data.tape.enabled ? `${data.tape.perMin.toLocaleString()} trades/min recorded, ${data.tape.daysOnDisk ?? 0} days on disk${data.tape.rowsOnDisk ? ` (~${(data.tape.rowsOnDisk / 1e6).toFixed(1)}M rows)` : ''}${data.tape.dropped ? `, ${data.tape.dropped.toLocaleString()} dropped` : ''}${data.tape.failed ? `, ${data.tape.failed.toLocaleString()} failed writes` : ''}` : 'off'}
            </p>
          )}
          {data.lastExit && (
            <p className={`mt-3 break-words text-sm ${crashed(data.lastExit.reason) ? 'text-down' : 'text-ink-2'}`}>
              Last stop ({new Date(data.lastExit.at).toLocaleString()}): {data.lastExit.reason}
            </p>
          )}
          {data.trading && <WhyNoTrades t={data.trading} />}
          {data.recentErrors.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {data.recentErrors.map((e) => (
                <li key={e.at + e.message} className="break-words">
                  {new Date(e.at).toLocaleTimeString()} — {e.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function WhyNoTrades({ t }: { t: NonNullable<SystemData['trading']> }) {
  const list = (title: string, rows: Array<{ reason: string; count: number }>) =>
    rows.length > 0 && (
      <div className="min-w-0">
        <div className="mb-1 text-xs text-muted">{title}</div>
        <ul className="space-y-0.5 text-xs">
          {rows.map((r) => (
            <li key={r.reason} className="flex justify-between gap-2">
              <span className="truncate text-ink-2">{r.reason}</span>
              <span className="tabular-nums text-muted">{r.count}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="text-sm font-medium text-ink">Buying (last hour)</div>
      <p className={`mt-1 text-sm ${t.lastHour.entries === 0 ? 'text-warning' : 'text-ink-2'}`}>
        {t.summary}. Checked {t.lastHour.evaluated}, buy signals {t.lastHour.buySignals}, bought {t.lastHour.entries}
        {t.lastEntryAt ? ` · last buy ${duration(t.minutesSinceEntry * 60)} ago` : ''}.
      </p>
      {t.strategies && t.strategies.length > 0 && <StrategyFunnels rows={t.strategies} />}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {list('Why coins were skipped', t.topSkips)}
        {list('Why buy signals were refused', t.topRefusals)}
      </div>
    </div>
  );
}

/** One line per strategy: is it running and how far its coins got (checked → passed rules → buy signal → bought). */
function StrategyFunnels({ rows }: { rows: StrategyFunnel[] }) {
  const verdict = (r: StrategyFunnel): { text: string; tone: string } => {
    if (r.on === false) return { text: 'switched off', tone: 'text-muted' };
    if (r.bought > 0) return { text: 'buying', tone: 'text-up' };
    if (r.checked === 0) return { text: 'no coins found', tone: 'text-warning' };
    if (r.rulesOk === 0) return { text: 'every coin fails a rule', tone: 'text-warning' };
    if (r.signal === 0) return { text: 'score under the bar', tone: 'text-warning' };
    if (r.refused > 0) return { text: 'signals refused', tone: 'text-warning' };
    if (r.dipWait + r.confirming > 0) return { text: 'waiting for entries', tone: 'text-ink-2' };
    return { text: 'signals held back', tone: 'text-warning' };
  };
  const held = (r: StrategyFunnel) => {
    const parts: string[] = [];
    if (r.dipWait) parts.push(`${r.dipWait} dip wait${r.dipGaveUp ? ` (${r.dipGaveUp} gave up)` : ''}`);
    if (r.confirming) parts.push(`${r.confirming} confirming`);
    if (r.notConfirmed) parts.push(`${r.notConfirmed} didn't confirm`);
    if (r.heldBack) parts.push(`${r.heldBack} held back`);
    if (r.refused) parts.push(`${r.refused} refused`);
    return parts.join(' · ');
  };
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs text-muted">Strategies — checked → passed rules → buy signal → bought</div>
      <ul className="divide-y divide-line text-xs">
        {rows.map((r) => {
          const v = verdict(r);
          const h = held(r);
          return (
            <li key={r.strategy} className="py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-ink">{STRATEGY_LABEL[r.strategy] ?? r.strategy}</span>
                <span className={v.tone}>{v.text}</span>
              </div>
              <div className="tabular-nums text-ink-2">
                {r.checked} → {r.rulesOk} → {r.signal} → <span className={r.bought ? 'text-up' : ''}>{r.bought}</span>
              </div>
              {h && <div className="text-muted">{h}</div>}
              {r.topSkips && r.topSkips.length > 0 && r.rulesOk < r.checked && (
                <div className="truncate text-muted">skipped: {r.topSkips.map((x) => `${x.reason} ×${x.count}`).join(' · ')}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: React.ReactNode; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-muted">{label}</div>
      <div className={`truncate font-medium tabular-nums ${warn ? 'text-down' : 'text-ink'}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
