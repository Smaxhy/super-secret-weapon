import { Badge, Card, Row, Rows, StatTile } from './ui';

/** v28.16: mirrors src/forex/carry.ts CarryReport (only what the card reads). */
interface CarryStats { trades: number; daysIn: number; days: number; totalPct: number; apy: number; fundPct: number; costPct: number; liquidations: number; weeks: number; greenWeekPct: number; worstWeekPct: number }
export interface CarryReport {
  at: number;
  coins: number;
  oosFrom: number;
  rule: { entryApy: number; exitApy: number } | null;
  first: CarryStats | null;
  unseen: CarryStats | null;
  always: CarryStats | null;
  byCoin: Array<{ id: string; first: CarryStats; unseen: CarryStats }>;
  verdict: 'edge' | 'maybe' | 'no' | 'none';
  why: string;
  now: Array<{ id: string; apy: number; inNow: boolean }>;
  notModelled: string[];
}

const signed = (x: number) => `${x > 0 ? '+' : ''}${x}`;
const VERDICT: Record<CarryReport['verdict'], { label: string; tone: 'up' | 'warn' | 'down' | 'neutral' }> = {
  edge: { label: 'Passes', tone: 'up' },
  maybe: { label: 'Maybe', tone: 'warn' },
  no: { label: 'Fails', tone: 'down' },
  none: { label: 'Not enough data', tone: 'neutral' },
};

/** Funding carry: hold the coin, short the same amount on the perpetual future, collect funding. Graded, never traded. */
export function CarryCard({ c }: { c: CarryReport | null | undefined }) {
  if (!c) return null;
  const v = VERDICT[c.verdict];
  const u = c.unseen;
  return (
    <Card
      title="Funding carry (coin held + same amount shorted)"
      subtitle="Price moves cancel out; the short side collects the funding traders pay to stay long. It goes in when the last 7 days' funding pays more than the rule's threshold a year and out when it drops. The threshold is picked on the first 70% of the funding history and graded once on the last 30%. Test only — nothing is traded."
      action={<Badge tone={v.tone}>{v.label}</Badge>}
    >
      {u && c.first ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile compact label="Unseen 30%, a year" value={`${signed(u.apy)}%`} sub={`${signed(u.totalPct)}% over ${u.weeks} weeks`} tone={u.apy > 0 ? 'up' : u.apy < 0 ? 'down' : undefined} />
            <StatTile compact label="Funding earned vs costs" value={`${signed(u.fundPct)}%`} sub={`costs −${u.costPct}% · ${u.trades} trades`} />
            <StatTile compact label="Green weeks (unseen)" value={`${u.greenWeekPct}%`} sub={`worst week ${signed(u.worstWeekPct)}%`} />
            <StatTile compact label="First 70% (picked there)" value={`${signed(c.first.apy)}% a year`} sub={`${c.first.trades} trades · ${c.first.liquidations} liquidations`} />
          </div>
          <p className="mt-3 text-sm text-ink-2">{c.why}.</p>
          <Rows>
            {c.rule && <Row label="The rule it picked" value={`in above ${c.rule.entryApy}% a year`} sub={`out under ${c.rule.exitApy}% a year`} />}
            {c.always && <Row label="Always in (no rule), unseen" value={`${signed(c.always.apy)}% a year`} sub="the yardstick: the rule should beat just holding the pair" />}
            <Row label="Liquidations (unseen)" value={String(u.liquidations)} sub="the short side's margin ran out on a big rise (2× leverage)" />
          </Rows>
          <div className="mt-3 text-xs font-semibold text-muted">Per coin, unseen part</div>
          <ul className="mt-1 divide-y divide-line">
            {c.byCoin.map((r) => {
              const n = c.now.find((x) => x.id === r.id);
              return (
                <li key={r.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <span className="font-medium text-ink">{r.id.replace(/USD$/, '')}</span>
                  {n?.inNow && <Badge tone="up">rule is in now</Badge>}
                  <span className="ml-auto tabular text-xs text-muted">funding now {signed(n?.apy ?? 0)}% a year</span>
                  <span className={`tabular w-20 text-right ${r.unseen.apy > 0 ? 'text-up' : r.unseen.apy < 0 ? 'text-down' : 'text-ink-2'}`}>{signed(r.unseen.apy)}%/yr</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-sm text-ink-2">{c.why}.</p>
      )}
      <p className="mt-2 text-xs text-muted">Not in the test: {c.notModelled.join('; ')}. Idea from go-trader's research (2023–24 only); this is the same test on our own funding history.</p>
    </Card>
  );
}
