/**
 * Bot health: is the bot restarting, why did it last stop, is the VPS running
 * the newest code? Banner (Overview) + full panel (Scanner page).
 */
import { useApi } from '../hooks/useApi';
import { duration, STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { Badge, Card, Funnel, Rows, Row, SectionLabel, StatTile } from './ui';

export interface SystemData {
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
  meme?: { enabled: boolean; hasKey: boolean; today: number; spentTodayUsd: number; budgetUsd: number } | null;
  /** v11.7: requests per provider today vs the owner's budgets. */
  usage?: { day: string; providers: Record<string, { used: number; budget: number; softLimitHit: boolean }> } | null;
  /** v11.14: the live path (dry-run simulations of the real transactions). */
  live?: { mode: 'PAPER' | 'LIVE'; wallet: string | null; simulated: number; okPct: number | null; errors: number; blockers: string[] } | null;
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

export interface StrategyFunnel {
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

export const isBotBehind = botBehind;
export type { UpdateInfo };

/** Scanner board, top: nine live tiles (stream speed, last hour of buying, tape, wallet book, usage). */
export function StatusStrip({ data, tradesPerMin, launchesPerMin }: { data: SystemData | null; tradesPerMin: number | null; launchesPerMin: number | null }) {
  const t = data?.trading;
  const helius = data?.usage?.providers.helius;
  const usageWarn = !!data?.usage && Object.values(data.usage.providers).some((p) => p.softLimitHit);
  const k = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());
  return (
    <section aria-label="Live status" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9">
      <StatTile compact label="Trades / min" value={k(tradesPerMin)} sub="on the live stream" tone={tradesPerMin === 0 ? 'down' : undefined} />
      <StatTile compact label="Launches / min" value={launchesPerMin === null ? '—' : launchesPerMin.toFixed(1)} sub="new coins" />
      <StatTile compact label="Checked (1 h)" value={k(t?.lastHour.evaluated)} sub="coins scored" />
      <StatTile compact label="Signals (1 h)" value={k(t?.lastHour.buySignals)} sub="passed every rule" />
      <StatTile compact label="Bought (1 h)" value={k(t?.lastHour.entries)} sub={t && t.lastHour.entries === 0 ? 'no buys' : 'entries'} tone={t && t.lastHour.entries > 0 ? 'up' : undefined} />
      <StatTile compact label="Last buy" value={t?.lastEntryAt ? duration(t.minutesSinceEntry * 60) : '—'} sub={t?.lastEntryAt ? 'ago' : 'none yet'} tone={t && t.minutesSinceEntry >= 60 ? 'warn' : undefined} />
      <StatTile compact label="Tape" value={data?.tape ? (data.tape.enabled ? `${k(data.tape.perMin)}/min` : 'off') : '—'} sub={data?.tape?.enabled ? `${data.tape.daysOnDisk ?? 0} days on disk` : 'replay recording'} tone={data?.tape?.enabled && data.tape.failed > 0 && data.tape.written === 0 ? 'down' : undefined} />
      <StatTile compact label="Wallet book" value={data?.walletBook ? (data.walletBook.enabled ? k(data.walletBook.wallets) : 'off') : '—'} sub={data?.walletBook?.enabled ? `${data.walletBook.proven} proven · ${data.walletBook.dumpers} dumpers` : 'wallets known'} />
      <StatTile compact label="Meme reader" value={data?.meme ? (data.meme.enabled && data.meme.hasKey ? String(data.meme.today) : data.meme.enabled ? 'no key' : 'off') : '—'} sub={data?.meme?.enabled ? `$${data.meme.spentTodayUsd.toFixed(3)} of $${data.meme.budgetUsd} today` : 'AI reads today'} />
      <StatTile compact label="Helius today" value={helius ? k(helius.used) : '—'} sub={helius ? (helius.budget ? `of ${k(helius.budget)}${usageWarn ? ' · lookups paused' : ''}` : 'no budget set') : 'requests'} tone={usageWarn ? 'warn' : undefined} />
    </section>
  );
}

/** One horizontal stepper per strategy, in a grid: is it on, and how far its coins got. */
export function StrategyFunnelGrid({ rows }: { rows: StrategyFunnel[] }) {
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
  const sorted = [...rows].sort((a, b) => Number(b.on !== false) - Number(a.on !== false) || b.checked - a.checked);
  return (
    <ul className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {sorted.map((r) => {
        const v = verdict(r);
        const h = held(r);
        return (
          <li key={r.strategy} className={`card min-w-0 p-4 ${r.on === false ? 'opacity-60' : ''}`}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{STRATEGY_LABEL[r.strategy] ?? r.strategy}</span>
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
              <ul className="mt-2 space-y-0.5 text-xs text-muted">
                {r.topSkips.slice(0, 3).map((x) => (
                  <li key={x.reason} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate" title={x.reason}>{x.reason}</span>
                    <span className="tabular shrink-0">×{x.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Bot process details: version, restarts, memory, lag, last stop, recent errors. */
export function SystemDetails({ data, upd }: { data: SystemData; upd: UpdateInfo | null | undefined }) {
  return (
    <Card title="Bot process" subtitle="Is it running, up to date and not overloaded.">
      <Rows>
        <Row label="Running for" value={duration(data.uptimeSec)} />
        <Row label="Bot version" value={<span className={botBehind(upd) ? 'text-down' : ''}>{data.version}</span>} sub={botBehind(upd) ? `newest ${upd!.last!.remote}` : versionMismatch(data.version) ? `up to date (site ${SITE_VERSION})` : 'up to date'} />
        <Row label="Restarts (24 h)" value={data.restarts24h ?? '—'} tone={(data.crashes24h ?? 0) >= 3 ? 'down' : undefined} sub={data.crashes24h != null ? `${data.crashes24h} crash${data.crashes24h === 1 ? '' : 'es'}, rest = updates` : undefined} />
        <Row label="Memory" value={`${data.memory.rssMb} MB`} sub={data.redisMemoryMb !== null ? `Redis ${data.redisMemoryMb} MB` : undefined} />
        <Row label="Event-loop lag" value={data.eventLoopLagMs !== null ? `${data.eventLoopLagMs} ms` : '—'} tone={(data.eventLoopLagMs ?? 0) > 1000 ? 'down' : undefined} />
        {data.usage && (
          <Row label="FluxRPC today" value={`${data.usage.providers.flux?.used.toLocaleString() ?? 0} / ${data.usage.providers.flux?.budget ? data.usage.providers.flux.budget.toLocaleString() : '∞'}`} />
        )}
        {data.live && (
          <Row
            label="Live path"
            value={<span className={data.live.mode === 'LIVE' ? 'font-semibold text-down' : ''}>{data.live.mode === 'LIVE' ? 'LIVE' : `${data.live.simulated.toLocaleString()} simulated, ${data.live.okPct ?? '—'}% OK`}</span>}
            sub={data.live.mode === 'LIVE' ? `wallet ${data.live.wallet ?? '—'}` : data.live.errors ? `${data.live.errors} would fail` : 'paper dry run of the real transactions'}
            tone={data.live.mode === 'PAPER' && data.live.okPct !== null && data.live.okPct < 95 ? 'down' : undefined}
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
                <span className="tabular text-ink-2">{new Date(e.at).toLocaleTimeString()}</span> {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
