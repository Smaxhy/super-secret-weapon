/** Forex → Auto-bot: the bot's own $1,000 practice account, traded by itself from the strategies' live signals. */
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Button, Card, Row, Rows, Stack, StatTile } from './ui';

interface Pos { id: string; pair: string; side: 1 | -1; entry: number; px: number; marginUsd: number; leverage: number; stop: number | null; target: number | null; openedAt: number; pnlUsd: number; pnlPct: number; strategy?: string }
interface Closed { id: string; pair: string; side: 1 | -1; entry: number; exit: number; pnlUsd: number; reason: string; closedAt: number; strategy?: string }
interface Acct { startUsd: number; balanceUsd: number; equityUsd: number; marginUsedUsd: number; freeMarginUsd: number; marginLevelPct: number | null; positions: Pos[]; closed: Closed[] }
interface Data { account: Acct | null; log: Array<{ t: number; e: string }>; chosen: string[]; dropped?: string[] }

const dp = (id: string) => (id.includes('JPY') ? 3 : id === 'XAUUSD' ? 2 : id === 'XAGUSD' ? 3 : 5);
const usd = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function FxBot() {
  const { data, reload } = useApi<Data>('/api/forex/bot', 10_000);
  const a = data?.account;
  const wins = a ? a.closed.filter((x) => x.pnlUsd > 0).length : 0;
  const reset = async () => {
    if (!confirm("Reset the bot's account to $1,000? Its positions and history are cleared.")) return;
    await api('/api/forex/practice/reset', { method: 'POST', body: JSON.stringify({ startUsd: 1000, acct: 'bot' }) });
    await reload();
  };
  const close = async (id: string) => {
    await api('/api/forex/practice/close', { method: 'POST', body: JSON.stringify({ id, acct: 'bot' }) });
    await reload();
  };
  return (
    <Stack>
      <Card accent>
        <p className="text-sm text-ink-2">
          Every hour, right after the candle closes, the bot checks all strategies on all 12 markets. When a chosen strategy fires, it opens the trade here with that strategy's stop and target, risking <span className="font-semibold text-ink">1% of the account</span> at 30× leverage (max 8 trades at once). It closes when the stop, target, trail or time exit hits. Fake money, real prices.
        </p>
        <p className="mt-2 text-sm text-ink-2">It also waits 30 min either side of big news, skips bank holidays, opens nothing in the last 2 hours of the week and closes everything 30 min before the Friday close. And it learns from itself: a strategy that has lost money over 12+ of its trades is dropped.</p>
        {!!data?.dropped?.length && <p className="mt-2 text-xs text-down">Dropped for losing: {data.dropped.join(', ')}</p>}
        <p className="mt-2 text-xs text-muted">Chosen: strategies marked Edge or Maybe on unseen data, plus the four with published evidence (time-series momentum ×2, local-hours effect, London fix flow). {data?.chosen.length ? `${data.chosen.length} strategy × timeframe combinations right now.` : ''}</p>
      </Card>
      {a && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile compact label="Equity" value={usd(a.equityUsd)} sub={`started ${usd(a.startUsd)}`} tone={a.equityUsd > a.startUsd ? 'up' : a.equityUsd < a.startUsd ? 'down' : undefined} />
          <StatTile compact label="Profit" value={usd(a.equityUsd - a.startUsd)} sub={`${(((a.equityUsd / a.startUsd) - 1) * 100).toFixed(1)}%`} tone={a.equityUsd >= a.startUsd ? 'up' : 'down'} />
          <StatTile compact label="Closed trades" value={`${a.closed.length}`} sub={a.closed.length ? `${Math.round((wins / a.closed.length) * 100)}% won` : 'none yet'} />
          <StatTile compact label="Open" value={`${a.positions.length}`} sub={`margin ${usd(a.marginUsedUsd)}`} />
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Open trades">
          {!a?.positions.length ? <p className="text-sm text-ink-2">Nothing open. It waits for a signal on an hourly close.</p> : (
            <ul className="divide-y divide-line">
              {a.positions.map((x) => (
                <li key={x.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge tone={x.side === 1 ? 'up' : 'down'}>{x.side === 1 ? 'Long' : 'Short'}</Badge>
                      <span className="font-medium text-ink">{x.pair}</span>
                      <span className="truncate text-xs text-muted">{x.strategy}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{x.entry.toFixed(dp(x.pair))} → {x.px.toFixed(dp(x.pair))}{x.stop !== null ? ` · SL ${x.stop.toFixed(dp(x.pair))}` : ''}{x.target !== null ? ` · TP ${x.target.toFixed(dp(x.pair))}` : ''} · {ago(new Date(x.openedAt).toISOString())}</div>
                  </div>
                  <div className={`tabular shrink-0 text-right font-semibold ${tone(x.pnlUsd)}`}>{usd(x.pnlUsd)}</div>
                  <Button size="sm" variant="ghost" onClick={() => void close(x.id)}>Close</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="What it did" subtitle="Latest decisions, newest first.">
          {!data?.log.length ? <p className="text-sm text-ink-2">No decisions yet. The first comes on the next hourly close.</p> : (
            <Rows>
              {data.log.slice(0, 25).map((l, k) => (
                <Row key={k} label={l.e} value={<span className="text-xs text-muted">{ago(new Date(l.t).toISOString())}</span>} />
              ))}
            </Rows>
          )}
        </Card>
      </div>
      <Card title="Closed trades" action={<Button size="sm" variant="ghost" onClick={() => void reset()}>Reset to $1,000</Button>}>
        {!a?.closed.length ? <p className="text-sm text-ink-2">None yet.</p> : (
          <Rows>
            {a.closed.slice(0, 60).map((x) => (
              <Row key={x.id} label={`${x.side === 1 ? 'Long' : 'Short'} ${x.pair} · ${x.strategy ?? 'manual'}`} sub={`${x.entry.toFixed(dp(x.pair))} → ${x.exit.toFixed(dp(x.pair))} · ${x.reason} · ${ago(new Date(x.closedAt).toISOString())}`} value={<span className={tone(x.pnlUsd)}>{usd(x.pnlUsd)}</span>} />
            ))}
          </Rows>
        )}
      </Card>
    </Stack>
  );
}
