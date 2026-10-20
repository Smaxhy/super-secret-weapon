/**
 * v17 "Data feeds" (Forex → Setup): every free data source, when it last worked and what it affects, plus how up to
 * date each market's prices are. A stale market gets no new bot trades (open ones keep their stops).
 */
import { useApi } from '../hooks/useApi';
import { ago } from '../lib/format';
import { apiBase } from '../lib/ws';
import { Badge, Card, Row, Rows } from './ui';

interface Feed {
  id: string;
  label: string;
  status: 'ok' | 'stale' | 'down' | 'off' | 'closed' | 'never';
  ageMin: number | null;
  okAt: number | null;
  fails: number;
  error: string | null;
  affects: string;
  fallback: string | null;
  pausedUntil: number | null;
}
interface Age { id: string; tf: string; lastT: number | null; lagBars: number; status: 'fresh' | 'stale' | 'closed' | 'none' }
interface Data { at: number; open: boolean; feeds: Feed[]; dataAge: Age[]; calendarBlind: boolean | null; labError: { t: number; msg: string } | null }

const TONE: Record<Feed['status'], 'up' | 'warn' | 'down' | 'neutral'> = { ok: 'up', stale: 'warn', down: 'down', off: 'neutral', closed: 'neutral', never: 'neutral' };
const WORD: Record<Feed['status'], string> = { ok: 'ok', stale: 'late', down: 'down', off: 'off', closed: 'market shut', never: 'not yet' };

export function FxFeeds() {
  const { data } = useApi<Data>(`${apiBase()}/feeds`, 30_000);
  if (!data) return null;
  const stale = data.dataAge.filter((a) => a.status === 'stale' || a.status === 'none');
  return (
    <Card title="Data feeds" subtitle="Every source is free and needs no account. When one fails the bot keeps going on what it has: a market whose prices fall behind gets no NEW trades until they catch up, open trades keep their stops, and nothing is ever closed at a made-up price.">
      <Rows>
        {data.labError && <Row label={<span className="text-down">Last hourly run failed</span>} value={ago(new Date(data.labError.t).toISOString())} sub={data.labError.msg} />}
        {data.calendarBlind && <Row label={<span className="text-down">News calendar unavailable</span>} value="" sub="dollar pairs and metals wait out the usual US release times (08:25–08:50 and 09:55–10:15 New York) until it is back" />}
        {data.feeds.map((f) => (
          <Row
            key={f.id}
            label={<>{f.label} <Badge tone={TONE[f.status]}>{WORD[f.status]}</Badge></>}
            value={f.okAt ? <span className="text-xs">{ago(new Date(f.okAt).toISOString())}</span> : <span className="text-xs text-muted">never</span>}
            sub={[
              `affects: ${f.affects}`,
              f.status !== 'ok' && f.status !== 'off' && f.status !== 'closed' && f.fallback ? `meanwhile: ${f.fallback}` : null,
              f.error && f.status !== 'ok' ? `last error: ${f.error}` : null,
              f.pausedUntil ? `paused until ${new Date(f.pausedUntil).toLocaleTimeString()} (kept failing)` : null,
            ].filter(Boolean).join(' · ')}
          />
        ))}
      </Rows>
      <div className="mt-3 text-sm font-medium text-ink">Prices per market</div>
      <p className="text-xs text-muted">{stale.length ? `${stale.length} behind: no new trades there until they catch up.` : data.open ? 'Every market is up to date.' : 'Forex is shut for the weekend.'}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {data.dataAge.map((a) => (
          <Badge key={`${a.tf}:${a.id}`} tone={a.status === 'fresh' ? 'up' : a.status === 'closed' ? 'neutral' : 'down'} title={a.lastT ? `newest candle ${new Date(a.lastT).toUTCString()}` : 'no candles'}>
            {a.id} {a.tf}{a.status === 'stale' ? ` · ${a.lagBars} behind` : a.status === 'none' ? ' · none' : ''}
          </Badge>
        ))}
      </div>
    </Card>
  );
}
