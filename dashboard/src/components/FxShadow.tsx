/**
 * v24 shadow book (owner: "enough solid signals that it could have made money on, firing setups but not executing").
 * Every signal of a chosen strategy the bot account refused — with the reason — and what the lab's identical paper
 * trade then did. Per reason: how many, how many finished, win %, R and the money at the bot's base risk.
 */
import { useState } from 'react';
import { Badge, Card, Row, Rows, Tabs } from './ui';
import { ago } from '../lib/format';

export interface ShadowStat { n: number; done: number; wins: number; totalR: number; avgR: number | null; winPct: number | null; usd: number }
export interface ShadowSummary {
  at: number;
  total: ShadowStat;
  byKind: Array<{ kind: string; example: string } & ShadowStat>;
  byStrategy: Array<{ key: string } & ShadowStat>;
  open: Array<{ key: string; strategy: string; tf: string; pair: string; side: 1 | -1; entry: number; stop: number; target: number | null; t: number; why: string; kind: string; rNow: number | null }>;
  recent: Array<{ key: string; strategy: string; tf: string; pair: string; side: 1 | -1; t: number; why: string; kind: string; r?: number | null; exitT?: number | null; reason?: string | null }>;
  riskPct: number;
}

const KIND: Record<string, string> = {
  agree: 'Market checks did not agree',
  market_rec: 'No winning record on that market',
  judge_no: 'The signal judge said no',
  judge_missing: "The signal judge couldn't score it",
  cooldown: 'Cooling off after a trade there',
  caps: 'Slots full',
  news: 'News / holiday / speech',
  clock: 'Weekly close / rollover',
  stale_feed: 'Candles behind (feed)',
  check_data: 'A check had no data',
  shock: 'Price shock',
  late: 'Price ran away from the signal',
  ccy_cap: 'Too much on one currency',
  heat: 'Correlated-risk cap',
  margin: 'No free margin',
  other: 'Other',
};

const usd = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(0)}`;
const r = (x: number | null | undefined) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
const tone = (x: number | null | undefined) => (x == null ? 'text-ink-2' : x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function ShadowCard({ s, names }: { s: ShadowSummary | null | undefined; names?: Record<string, string> }) {
  const [tab, setTab] = useState<'reasons' | 'strategies' | 'open' | 'recent'>('reasons');
  if (!s) return null;
  const t = s.total;
  const head = t.n === 0 ? 'Nothing held back in the last 30 days.' : `${t.n} signals held back in 30 days, ${t.done} finished: they would have made ${usd(t.usd)} (${r(t.totalR)}${t.winPct != null ? `, ${t.winPct.toFixed(0)}% won` : ''}) at ${s.riskPct}% risk a trade.`;
  const name = (k: string) => {
    const [id, tf] = k.split(':');
    return `${names?.[id ?? ''] ?? id} (${tf})`;
  };
  return (
    <Card title="Trades it held back (shadow book)" subtitle="Every signal of a chosen strategy the bot refused, with the reason, traded on paper by the lab anyway. If a reason keeps blocking winners, it is costing money; if it blocks losers, it is earning its keep.">
      <p className={`mb-3 text-sm font-medium ${t.done ? tone(t.totalR) : 'text-ink-2'}`}>{head}</p>
      <Tabs tabs={[{ key: 'reasons', label: 'By reason', badge: s.byKind.length || null }, { key: 'strategies', label: 'By strategy', badge: s.byStrategy.length || null }, { key: 'open', label: 'Still running', badge: s.open.length || null }, { key: 'recent', label: 'Finished', badge: s.recent.length || null }]} value={tab} onChange={(k) => setTab(k as typeof tab)} className="mb-3" />
      {tab === 'reasons' && (s.byKind.length ? (
        <Rows>
          {s.byKind.map((k) => (
            <Row key={k.kind} label={KIND[k.kind] ?? k.kind} sub={`${k.n} held back · ${k.done} finished${k.winPct != null ? ` · ${k.winPct.toFixed(0)}% won` : ''} · e.g. "${k.example}"`} value={<span className={tone(k.done ? k.totalR : null)}>{k.done ? `${usd(k.usd)} · ${r(k.totalR)}` : 'no result yet'}</span>} />
          ))}
        </Rows>
      ) : <p className="text-sm text-ink-2">Nothing held back yet.</p>)}
      {tab === 'strategies' && (s.byStrategy.length ? (
        <Rows>
          {s.byStrategy.map((k) => (
            <Row key={k.key} label={name(k.key)} sub={`${k.n} held back · ${k.done} finished${k.winPct != null ? ` · ${k.winPct.toFixed(0)}% won` : ''}`} value={<span className={tone(k.done ? k.totalR : null)}>{k.done ? `${usd(k.usd)} · ${r(k.totalR)}` : '—'}</span>} />
          ))}
        </Rows>
      ) : <p className="text-sm text-ink-2">Nothing held back yet.</p>)}
      {tab === 'open' && (s.open.length ? (
        <Rows>
          {s.open.map((o) => (
            <Row key={o.key} label={`${o.side === 1 ? 'Long' : 'Short'} ${o.pair} · ${name(`${o.strategy}:${o.tf}`)}`} sub={`${ago(new Date(o.t).toISOString())} · ${o.why}`} value={<span className={tone(o.rNow)}>{o.rNow == null ? 'no price' : `${r(o.rNow)} so far`}</span>} />
          ))}
        </Rows>
      ) : <p className="text-sm text-ink-2">No held-back signal is still running.</p>)}
      {tab === 'recent' && (s.recent.length ? (
        <Rows>
          {s.recent.map((o) => (
            <Row key={o.key} label={<span>{o.side === 1 ? 'Long' : 'Short'} {o.pair} · {name(`${o.strategy}:${o.tf}`)} <Badge tone={(o.r ?? 0) > 0 ? 'up' : 'down'}>{o.reason ?? ''}</Badge></span>} sub={`${o.exitT ? ago(new Date(o.exitT).toISOString()) : ''} · ${KIND[o.kind] ?? o.kind}`} value={<span className={tone(o.r)}>{r(o.r)}</span>} />
          ))}
        </Rows>
      ) : <p className="text-sm text-ink-2">None finished yet.</p>)}
    </Card>
  );
}
