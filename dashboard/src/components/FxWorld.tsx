/**
 * v27.39 World events (News page): war / oil / shipping / sanctions / disaster / cyber / crash headlines from world and
 * energy news (Al Jazeera, BBC, Guardian, MEE, France 24, DW, UN, OilPrice), the alarms they raised and the markets those
 * pause. Display only; the rule lives in src/forex/world.ts.
 */
import { Badge, Card } from './ui';

export interface WorldAlarmV { kind: string; label: string; startedAt: number; lastAt: number; until: number; critical: boolean; count: number; sources: number; usualPerHour: number; markets: string[]; headlines: Array<{ t: number; title: string; source: string; link: string }> }
export interface WorldItemV { t: number; title: string; link: string; source: string; kinds: string[]; markets: string[]; critical: boolean }
export interface WorldView { alarms: WorldAlarmV[]; items: WorldItemV[] }

const KIND: Record<string, string> = { conflict: 'War', energy: 'Oil & energy', shipping: 'Shipping', sanctions: 'Sanctions', disaster: 'Disaster', cyber: 'Cyber', crash: 'Crash' };
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : `${Math.round(ms / 3_600_000)} h ago`);

export function WorldCard({ world, now }: { world: WorldView | null | undefined; now: number }) {
  if (!world) return null;
  const active = world.alarms.filter((a) => a.until >= now);
  const ended = world.alarms.filter((a) => a.until < now);
  return (
    <Card
      title="World events"
      subtitle="War, oil, shipping, sanctions, disasters, cyber attacks and crashes from world and energy news, read every 5 minutes. When one kind suddenly piles up (or one headline is critical, like a tanker hit or a strait closed) the bots open no new trades on the markets it moves until 45 minutes after the last headline."
    >
      {active.length ? (
        <ul className="space-y-3">
          {active.map((a) => (
            <li key={`${a.kind}:${a.startedAt}`} className="rounded-xl border border-critical/40 bg-critical/5 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="down">{KIND[a.kind] ?? a.kind}</Badge>
                {a.critical && <Badge tone="down">critical</Badge>}
                <span className="text-sm font-semibold text-ink">Alarm on · new trades paused until {time(a.until)}</span>
              </div>
              <p className="mt-1 text-sm text-ink-2">
                {a.count} headline{a.count === 1 ? '' : 's'} from {a.sources} source{a.sources === 1 ? '' : 's'} since {time(a.startedAt)} (usually {a.usualPerHour} an hour) · markets paused: {a.markets.join(', ') || 'none of ours'}
              </p>
              <ul className="mt-2 space-y-1">
                {a.headlines.slice(0, 4).map((h) => (
                  <li key={h.t + h.title} className="text-sm text-ink-2">
                    <a href={h.link} target="_blank" rel="noreferrer" className="hover:underline">{h.title}</a> <span className="text-xs text-muted">· {h.source} · {ago(now - h.t)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-2">No world-event alarm right now.{ended.length ? ` Last one: ${KIND[ended[0]!.kind] ?? ended[0]!.kind}, ended ${time(ended[0]!.until)}.` : ''}</p>
      )}
      {world.items.length > 0 && (
        <>
          <div className="mt-4 text-xs font-semibold text-muted">Latest world-event headlines</div>
          <ul className="mt-1 divide-y divide-line">
            {world.items.slice(0, 12).map((x) => (
              <li key={x.t + x.title} className="py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {x.kinds.map((k) => <Badge key={k} tone={x.critical ? 'down' : 'neutral'}>{KIND[k] ?? k}</Badge>)}
                  <span className="text-xs text-muted">{x.source} · {ago(now - x.t)}{x.markets.length ? ` · moves ${x.markets.slice(0, 6).join(', ')}` : ''}</span>
                </div>
                <a href={x.link} target="_blank" rel="noreferrer" className="mt-0.5 block text-sm text-ink hover:underline">{x.title}</a>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
