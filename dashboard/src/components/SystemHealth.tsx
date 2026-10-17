/**
 * Bot health: is the bot restarting, why did it last stop, is the VPS running
 * the newest code? Banner (Overview) + full panel (Scanner page).
 */
import { useApi } from '../hooks/useApi';
import { duration, STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { Badge, Card, Funnel, RankedBars, Rows, Row, SectionLabel } from './ui';

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
  /** v11.6: the wallet book. */
  walletBook?: { enabled: boolean; wallets: number; proven: number; dumpers: number; losers: number; bots: number } | null;
  /** v11.7: requests per provider today vs the owner's budgets. */
  usage?: { day: string; providers: Record<string, { used: number; budget: number; softLimitHit: boolean }> } | null;
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
    <div role="status" className="pop mb-4 flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm text-ink">
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
  const usageWarn = !!data?.usage && Object.values(data.usage.providers).some((p) => p.softLimitHit);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card title="Bot health" subtitle="Is it running, up to date and not overloaded.">
        {error && <p className="text-sm text-down">{error}</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Running for" value={duration(data.uptimeSec)} />
              <Tile label="Restarts (24h)" value={data.restarts24h ?? '—'} warn={data.crashes24h != null ? data.crashes24h >= 3 : (data.restarts24h ?? 0) >= 3} sub={data.crashes24h != null ? `${data.crashes24h} crash${data.crashes24h === 1 ? '' : 'es'}, rest = updates` : undefined} />
              <Tile label="Memory" value={`${data.memory.rssMb} MB`} sub={data.redisMemoryMb !== null ? `Redis ${data.redisMemoryMb} MB` : undefined} />
              <Tile label="Lag" value={data.eventLoopLagMs !== null ? `${data.eventLoopLagMs} ms` : '—'} warn={(data.eventLoopLagMs ?? 0) > 1000} />
            </div>
            <Rows className="mt-4">
              <Row label="Bot version" value={<span className={botBehind(upd) ? 'text-down' : ''}>{data.version}</span>} sub={botBehind(upd) ? `newest ${upd!.last!.remote}` : versionMismatch(data.version) ? `up to date (site ${SITE_VERSION})` : 'up to date'} />
              {data.tape && (
                <Row
                  label="Tape (replay recording)"
                  value={data.tape.enabled ? `${data.tape.perMin.toLocaleString()} / min` : 'off'}
                  tone={data.tape.enabled && data.tape.failed > 0 && data.tape.written === 0 ? 'down' : undefined}
                  sub={data.tape.enabled ? `${data.tape.daysOnDisk ?? 0} days on disk${data.tape.rowsOnDisk ? ` · ~${(data.tape.rowsOnDisk / 1e6).toFixed(1)}M rows` : ''}${data.tape.dropped ? ` · ${data.tape.dropped.toLocaleString()} dropped` : ''}${data.tape.failed ? ` · ${data.tape.failed.toLocaleString()} failed writes` : ''}` : undefined}
                />
              )}
              {data.walletBook && <Row label="Wallet book" value={data.walletBook.enabled ? `${data.walletBook.wallets.toLocaleString()} wallets` : 'off'} sub={data.walletBook.enabled ? `${data.walletBook.proven} proven · ${data.walletBook.dumpers} known dumpers` : undefined} />}
              {data.usage && (
                <Row
                  label="Usage today"
                  tone={usageWarn ? 'down' : undefined}
                  value={`Helius ${data.usage.providers.helius?.used.toLocaleString() ?? 0} / ${data.usage.providers.helius?.budget ? data.usage.providers.helius.budget.toLocaleString() : '∞'}`}
                  sub={`FluxRPC ${data.usage.providers.flux?.used.toLocaleString() ?? 0} / ${data.usage.providers.flux?.budget ? data.usage.providers.flux.budget.toLocaleString() : '∞'}${usageWarn ? ' — optional lookups paused until midnight UTC' : ''}`}
                />
              )}
              {data.lastExit && <Row label="Last stop" value={<span className={crashed(data.lastExit.reason) ? 'text-down' : 'text-ink-2'}>{data.lastExit.reason}</span>} sub={new Date(data.lastExit.at).toLocaleString()} />}
            </Rows>
            {data.recentErrors.length > 0 && (
              <div className="mt-4">
                <SectionLabel>Recent errors</SectionLabel>
                <ul className="space-y-1 text-xs text-muted">
                  {data.recentErrors.map((e) => (
                    <li key={e.at + e.message} className="break-words">
                      <span className="tabular text-ink-2">{new Date(e.at).toLocaleTimeString()}</span> — {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>
      {data?.trading && <WhyNoTrades t={data.trading} />}
    </div>
  );
}

function WhyNoTrades({ t }: { t: NonNullable<SystemData['trading']> }) {
  const quiet = t.lastHour.entries === 0;
  return (
    <>
      <Card title="Buying (last hour)" subtitle={t.summary} action={quiet ? <Badge tone="warn">no buys</Badge> : <Badge tone="up">{t.lastHour.entries} bought</Badge>}>
        <Funnel
          steps={[
            { label: 'checked', n: t.lastHour.evaluated },
            { label: 'buy signals', n: t.lastHour.buySignals },
            { label: 'bought', n: t.lastHour.entries, tone: t.lastHour.entries > 0 ? 'up' : 'warn' },
          ]}
        />
        {t.lastEntryAt && <p className="mt-3 text-xs text-muted">Last buy {duration(t.minutesSinceEntry * 60)} ago.</p>}
        {t.strategies && t.strategies.length > 0 && <StrategyFunnels rows={t.strategies} />}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {t.topSkips.length > 0 && (
          <Card title="Why coins were skipped" subtitle="The rule each coin failed first, most common on top.">
            <RankedBars rows={t.topSkips.map((r) => ({ label: r.reason, count: r.count }))} />
          </Card>
        )}
        {t.topRefusals.length > 0 && (
          <Card title="Why buy signals were refused" subtitle="Coins that passed every rule but the trader said no.">
            <RankedBars rows={t.topRefusals.map((r) => ({ label: r.reason, count: r.count }))} tone="muted" />
          </Card>
        )}
      </div>
    </>
  );
}

/** One block per strategy: is it running and how far its coins got (checked → passed rules → buy signal → bought). */
function StrategyFunnels({ rows }: { rows: StrategyFunnel[] }) {
  const verdict = (r: StrategyFunnel): { text: string; tone: 'neutral' | 'up' | 'warn' } => {
    if (r.on === false) return { text: 'switched off', tone: 'neutral' };
    if (r.bought > 0) return { text: 'buying', tone: 'up' };
    if (r.checked === 0) return { text: 'no coins found', tone: 'warn' };
    if (r.rulesOk === 0) return { text: 'every coin fails a rule', tone: 'warn' };
    if (r.signal === 0) return { text: 'score under the bar', tone: 'warn' };
    if (r.refused > 0) return { text: 'signals refused', tone: 'warn' };
    if (r.dipWait + r.confirming > 0) return { text: 'waiting for entries', tone: 'neutral' };
    return { text: 'signals held back', tone: 'warn' };
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
    <div className="mt-5">
      <SectionLabel>Per strategy</SectionLabel>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const v = verdict(r);
          const h = held(r);
          return (
            <li key={r.strategy} className={`py-3 first:pt-0 last:pb-0 ${r.on === false ? 'opacity-60' : ''}`}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{STRATEGY_LABEL[r.strategy] ?? r.strategy}</span>
                <Badge tone={v.tone}>{v.text}</Badge>
              </div>
              <Funnel
                steps={[
                  { label: 'checked', n: r.checked },
                  { label: 'rules ok', n: r.rulesOk },
                  { label: 'signal', n: r.signal },
                  { label: 'bought', n: r.bought, tone: r.bought ? 'up' : undefined },
                ]}
              />
              {h && <div className="mt-2 text-xs text-muted">{h}</div>}
              {r.topSkips && r.topSkips.length > 0 && r.rulesOk < r.checked && (
                <div className="mt-2 text-xs text-muted">
                  <span className="text-ink-2">Skipped for:</span> {r.topSkips.map((x) => `${x.reason} ×${x.count}`).join(' · ')}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: React.ReactNode; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
      <div className="truncate text-xs font-medium text-muted">{label}</div>
      <div className={`tabular mt-1 truncate text-lg font-semibold leading-tight ${warn ? 'text-down' : 'text-ink'}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
