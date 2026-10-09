/**
 * Bot health: is the bot restarting, why did it last stop, is the VPS running
 * the newest code? Banner (Overview) + full panel (Scanner page).
 */
import { useApi } from '../hooks/useApi';
import { duration } from '../lib/format';
import { Card } from './ui';

interface SystemData {
  version: string;
  startedAt: string;
  uptimeSec: number;
  eventLoopLagMs: number | null;
  restarts24h: number | null;
  lastExit: { at: string; reason: string } | null;
  recentErrors: Array<{ at: string; message: string }>;
  memory: { rssMb: number; heapMb: number };
  redisMemoryMb: number | null;
}

/** Commit the website was built from (GitHub Actions sets GITHUB_SHA). */
export const SITE_VERSION = (import.meta.env.VITE_GIT_SHA ?? '').slice(0, 7) || 'dev';

const versionMismatch = (bot: string) => bot !== 'dev' && bot !== 'unknown' && SITE_VERSION !== 'dev' && bot !== SITE_VERSION;
const crashed = (r: string | undefined) => !!r && /killed|crash/i.test(r);

/** Short warning on the Overview when something is off (renders nothing when healthy). */
export function HealthBanner() {
  const { data } = useApi<SystemData>('/api/system', 60_000);
  if (!data) return null;
  const issues: string[] = [];
  if ((data.restarts24h ?? 0) >= 3) issues.push(`the bot restarted ${data.restarts24h}× in 24h`);
  if (crashed(data.lastExit?.reason) && data.uptimeSec < 3600) issues.push(`last stop: ${data.lastExit!.reason}`);
  if (versionMismatch(data.version) && data.uptimeSec > 20 * 60) issues.push(`the VPS runs older code (${data.version}) than this site (${SITE_VERSION}) — its update may be stuck`);
  if ((data.eventLoopLagMs ?? 0) > 1000) issues.push(`the bot is overloaded (${data.eventLoopLagMs} ms lag)`);
  if (!issues.length) return null;
  return (
    <div role="status" className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink">
      <strong>Bot health:</strong> {issues.join(' · ')}. Details on the Scanner page. On the VPS run <code className="break-all">bash /root/bot/scripts/diagnose.sh</code>.
    </div>
  );
}

export function SystemPanel() {
  const { data, error } = useApi<SystemData>('/api/system', 30_000);
  return (
    <Card title="Bot health" className="mt-4">
      {error && <p className="text-sm text-down">{error}</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Running for" value={duration(data.uptimeSec)} />
            <Stat label="Restarts (24h)" value={data.restarts24h ?? '—'} warn={(data.restarts24h ?? 0) >= 3} />
            <Stat label="Memory" value={`${data.memory.rssMb} MB`} sub={data.redisMemoryMb !== null ? `Redis ${data.redisMemoryMb} MB` : undefined} />
            <Stat label="Lag" value={data.eventLoopLagMs !== null ? `${data.eventLoopLagMs} ms` : '—'} warn={(data.eventLoopLagMs ?? 0) > 1000} />
            <Stat label="Bot version" value={data.version} warn={versionMismatch(data.version)} sub={`site ${SITE_VERSION}`} />
          </div>
          {data.lastExit && (
            <p className={`mt-3 break-words text-sm ${crashed(data.lastExit.reason) ? 'text-down' : 'text-ink-2'}`}>
              Last stop ({new Date(data.lastExit.at).toLocaleString()}): {data.lastExit.reason}
            </p>
          )}
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

function Stat({ label, value, sub, warn }: { label: string; value: React.ReactNode; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-muted">{label}</div>
      <div className={`truncate font-medium tabular-nums ${warn ? 'text-down' : 'text-ink'}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
