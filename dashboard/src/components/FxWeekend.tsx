/**
 * v27.32 weekend review (owner: "recap the past week, think how to improve all weekend, be fully ready on Monday").
 * The recap the bot builds on Saturday / Sunday: the Monday readiness checklist, what it learned in plain words, live vs
 * tested per strategy, what each hold-back rule saved or cost, the setups closest to going live, next week's big news,
 * and an AI review. Display only — nothing here changes what the bot trades.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { apiBase } from '../lib/ws';
import { Badge, Button, Card, Row, Rows } from './ui';

interface LiveCheck { key: string; name: string; liveN: number; liveR: number; liveAvgR: number | null; testN: number; testAvgR: number | null; vs: 'in_line' | 'worse' | 'better' | 'too_few' }
interface NearMiss { key: string; name: string; pair: string | null; n: number; avgR: number; pf: number | null; missing: string[] }
interface Recap {
  at: number;
  universe: 'fx' | 'crypto';
  week: string;
  headline: string;
  money: { pnlUsd: number; trades: number; wins: number; winPct: number | null; bestUsd: number | null; worstUsd: number | null; prevPnlUsd: number | null };
  live: LiveCheck[];
  list: { now: string[]; added: string[]; removed: string[]; proven: Array<{ pair: string; keys: string[] }> };
  losses: { n: number; normal: number; avoidable: number; pending: number; usd: number };
  heldBack: Array<{ kind: string; label: string; n: number; done: number; totalR: number }>;
  nearMisses: NearMiss[];
  monday: { events: Array<{ t: number; ccy: string; title: string }>; riskMode: string };
  ready: { ok: boolean; checks: Array<{ ok: boolean; text: string }> };
  lessons: string[];
}
interface Ai { at: number; summary: string; wentWell: string[]; wentWrong: string[]; ideas: Array<{ idea: string; test: string }>; watchMonday: string[] }
interface Data { review: { recap: Recap; ai: Ai | null } | null }

const usd = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const rTxt = (x: number | null) => (x === null ? '—' : `${x > 0 ? '+' : ''}${x}R`);
const VS: Record<LiveCheck['vs'], { label: string; tone: 'up' | 'down' | 'neutral' }> = {
  in_line: { label: 'as tested', tone: 'neutral' },
  worse: { label: 'worse than tested', tone: 'down' },
  better: { label: 'better than tested', tone: 'up' },
  too_few: { label: 'too few trades', tone: 'neutral' },
};
const day = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function WeekendCard() {
  const { data, reload } = useApi<Data>(`${apiBase()}/weekend`, 120_000);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rv = data?.review;
  const now = new Date();
  const weekend = now.getUTCDay() === 6 || now.getUTCDay() === 0;
  const run = async () => {
    setBusy(true);
    try {
      await api(`${apiBase()}/weekend/run`, { method: 'POST', body: '{}' });
      setTimeout(() => void reload(), 8_000);
    } finally {
      setTimeout(() => setBusy(false), 8_000);
    }
  };
  const action = <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run()}>{busy ? 'Reviewing…' : 'Review now'}</Button>;
  if (!rv) {
    return (
      <Card title="Weekend review" subtitle="On Saturday and Sunday the bot goes over its week and checks it is ready for Monday." action={action}>
        <p className="text-sm text-ink-2">No review yet: the first one is built this weekend (or tap Review now).</p>
      </Card>
    );
  }
  const { recap: r, ai } = rv;
  return (
    <Card
      accent={weekend}
      title={weekend ? 'Weekend review' : `Last weekend's review (week of ${r.week})`}
      subtitle={`Built ${ago(new Date(r.at).toISOString())}. What it learned is shown here; a change to what it trades still has to pass the lab's strict test first.`}
      action={action}
    >
      <p className={`mb-3 text-[15px] font-semibold ${r.ready.ok ? 'text-ink' : 'text-down'}`}>{r.headline}</p>
      <ul className="mb-4 space-y-1.5" aria-label="Ready for Monday">
        {r.ready.checks.map((c) => (
          <li key={c.text} className="flex gap-2 text-sm">
            <span aria-hidden className={c.ok ? 'text-up' : c.text.startsWith('nothing passes') ? 'text-ink-2' : 'text-down'}>{c.ok ? '✓' : c.text.startsWith('nothing passes') ? '·' : '✗'}</span>
            <span className="text-ink">{c.text}</span>
          </li>
        ))}
      </ul>
      <h3 className="mb-1.5 text-xs font-semibold text-muted">What it learned this week</h3>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-ink">
        {r.lessons.map((l) => <li key={l}>{l}</li>)}
      </ul>
      {ai && (
        <div className="mb-4 rounded-xl bg-surface-2 p-3">
          <h3 className="mb-1 text-xs font-semibold text-muted">AI review</h3>
          <p className="mb-2 text-sm text-ink">{ai.summary}</p>
          {ai.wentWell.length > 0 && <p className="mb-1 text-sm text-ink-2"><span className="font-semibold text-up">Went well:</span> {ai.wentWell.join(' · ')}</p>}
          {ai.wentWrong.length > 0 && <p className="mb-1 text-sm text-ink-2"><span className="font-semibold text-down">Went wrong:</span> {ai.wentWrong.join(' · ')}</p>}
          {ai.ideas.length > 0 && (
            <div className="mb-1 text-sm text-ink-2">
              <span className="font-semibold text-ink">Ideas for the lab to test:</span>
              <ul className="list-disc pl-5">{ai.ideas.map((i) => <li key={i.idea}>{i.idea} <span className="text-muted">— test: {i.test}</span></li>)}</ul>
            </div>
          )}
          {ai.watchMonday.length > 0 && <p className="text-sm text-ink-2"><span className="font-semibold text-ink">Watch on Monday:</span> {ai.watchMonday.join(' · ')}</p>}
        </div>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen((x) => !x)} aria-expanded={open}>{open ? 'Hide the details' : 'Show the details'}</Button>
      {open && (
        <div className="mt-4 space-y-4">
          <section>
            <h3 className="mb-1 text-xs font-semibold text-muted">The week in money</h3>
            <p className="text-sm text-ink">{r.money.trades ? `${usd(r.money.pnlUsd)} on ${r.money.trades} trades, ${r.money.winPct}% won${r.money.bestUsd !== null ? `, best ${usd(r.money.bestUsd)}` : ''}${r.money.worstUsd !== null ? `, worst ${usd(r.money.worstUsd)}` : ''}` : 'No closed trades.'}{r.money.prevPnlUsd !== null ? ` Last week ${usd(r.money.prevPnlUsd)}.` : ''}</p>
            {r.losses.n > 0 && <p className="text-sm text-ink-2">Losing trades: {r.losses.normal} normal, {r.losses.avoidable} avoidable{r.losses.pending ? `, ${r.losses.pending} still being graded` : ''} ({usd(r.losses.usd)}).</p>}
          </section>
          {r.live.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold text-muted">Live vs tested</h3>
              <Rows>
                {r.live.map((l) => (
                  <Row key={l.key} label={<span>{l.name} <Badge tone={VS[l.vs].tone}>{VS[l.vs].label}</Badge></span>} sub={`live ${l.liveN} trades, ${rTxt(l.liveAvgR)} a trade · tested ${l.testN} unseen trades, ${rTxt(l.testAvgR)} a trade`} value={<span className={l.liveR < 0 ? 'text-down' : l.liveR > 0 ? 'text-up' : ''}>{rTxt(l.liveR)}</span>} />
                ))}
              </Rows>
            </section>
          )}
          {r.heldBack.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold text-muted">Trades it held back, and what they did</h3>
              <Rows>
                {r.heldBack.map((h) => (
                  <Row key={h.kind} label={h.label} sub={`${h.n} refused, ${h.done} finished in the lab`} value={<span className={h.totalR > 0 ? 'text-down' : h.totalR < 0 ? 'text-up' : ''} title={h.totalR > 0 ? 'the rule cost this much' : 'the rule saved this much'}>{h.totalR > 0 ? `cost ${rTxt(h.totalR)}` : h.totalR < 0 ? `saved ${rTxt(-h.totalR)}` : '0R'}</span>} />
                ))}
              </Rows>
            </section>
          )}
          {r.nearMisses.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold text-muted">Closest to going live</h3>
              <Rows>
                {r.nearMisses.map((m) => (
                  <Row key={`${m.key}:${m.pair ?? ''}`} label={`${m.name}${m.pair ? ` on ${m.pair}` : ' (every market)'}`} sub={`still needs: ${m.missing.join('; ')}`} value={`${m.n} · ${rTxt(m.avgR)}`} />
                ))}
              </Rows>
            </section>
          )}
          {r.monday.events.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold text-muted">Big news next week</h3>
              <ul className="space-y-1 text-sm text-ink">{r.monday.events.map((e) => <li key={`${e.t}${e.title}`}><span className="text-muted">{day(e.t)}</span> · {e.ccy} {e.title}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </Card>
  );
}
