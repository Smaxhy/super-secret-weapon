/**
 * Data-feed settings entered from the dashboard (owner: "can you add it for me — I'm in bed").
 *
 * The owner pastes a paid feed (Chainstack WebSocket address, or a Yellowstone gRPC endpoint + token) on the
 * Controls page. It is stored ONLY in this server's database (BotConfig row `_feed`; "_" rows are never
 * part of the config the API hands out) and never in git. It overrides the .env values at the next start —
 * saving it restarts the bot (Docker brings it straight back). The API only ever shows masked values.
 */
import { prisma } from './prisma';

export const FEED_KEY = '_feed';

export interface FeedSettings {
  /** WebSocket for the trade stream (replaces TRADES_WS_URL), e.g. Chainstack's wss:// node address. */
  tradesWsUrl?: string | null;
  /** Yellowstone gRPC endpoint (https://…:443) + its x-token. */
  grpcEndpoint?: string | null;
  grpcToken?: string | null;
  /** Use the gRPC stream (needs an endpoint). */
  useGrpc?: boolean;
  updatedAt?: string;
}

/** Pure: check what the owner pasted. Returns the cleaned settings or an error. */
export function validateFeed(input: { tradesWsUrl?: unknown; grpcEndpoint?: unknown; grpcToken?: unknown; useGrpc?: unknown }, current: FeedSettings): { ok: true; value: FeedSettings } | { ok: false; error: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  const next: FeedSettings = { ...current };
  const ws = str(input.tradesWsUrl);
  if (ws !== undefined) {
    if (ws === '') next.tradesWsUrl = null;
    else if (!/^wss?:\/\/[^\s]+$/i.test(ws)) return { ok: false, error: 'The WebSocket address must start with wss://' };
    else next.tradesWsUrl = ws;
  }
  const ep = str(input.grpcEndpoint);
  if (ep !== undefined) {
    if (ep === '') next.grpcEndpoint = null;
    else if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/i.test(ep)) return { ok: false, error: 'The gRPC endpoint must look like https://name.example.com:443' };
    else next.grpcEndpoint = ep.replace(/\/$/, '');
  }
  const tk = str(input.grpcToken);
  if (tk !== undefined) next.grpcToken = tk === '' ? null : tk;
  if (input.useGrpc !== undefined) next.useGrpc = input.useGrpc === true;
  if (next.useGrpc && !next.grpcEndpoint) return { ok: false, error: 'Add the gRPC endpoint before switching gRPC on' };
  next.updatedAt = new Date().toISOString();
  return { ok: true, value: next };
}

/** Pure: show a secret-bearing address without the secret (keeps scheme + host). */
export function maskUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const m = /^(\w+:\/\/)([^/?#]+)(.*)$/.exec(u);
  if (!m) return '••••';
  const host = m[2]!.replace(/^[^@]*@/, '');
  return `${m[1]}${host}${m[3] ? '/••••' : ''}`;
}

export async function loadFeedSettings(): Promise<FeedSettings> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: FEED_KEY } });
    return (row?.value as FeedSettings | null) ?? {};
  } catch {
    return {};
  }
}

export async function saveFeedSettings(s: FeedSettings): Promise<void> {
  await prisma.botConfig.upsert({ where: { key: FEED_KEY }, update: { value: s as object }, create: { key: FEED_KEY, value: s as object } });
}

/** What the bot actually uses: dashboard settings over .env. */
export function effectiveFeed(
  s: FeedSettings,
  env: { DATA_SOURCE: string; TRADES_WS_URL: string; GRPC_ENDPOINT?: string; GRPC_TOKEN?: string },
): { dataSource: string; tradesWsUrl: string; grpcEndpoint: string | undefined; grpcToken: string | undefined; from: { trades: 'dashboard' | 'env'; grpc: 'dashboard' | 'env' } } {
  const grpcEndpoint = s.grpcEndpoint || env.GRPC_ENDPOINT || undefined;
  const grpcToken = s.grpcEndpoint ? s.grpcToken || undefined : env.GRPC_TOKEN;
  const dataSource = s.useGrpc && grpcEndpoint ? 'grpc' : s.useGrpc === false && env.DATA_SOURCE === 'grpc' ? 'hybrid' : env.DATA_SOURCE;
  return {
    dataSource,
    tradesWsUrl: s.tradesWsUrl || env.TRADES_WS_URL,
    grpcEndpoint,
    grpcToken,
    from: { trades: s.tradesWsUrl ? 'dashboard' : 'env', grpc: s.grpcEndpoint ? 'dashboard' : 'env' },
  };
}

/** What this run started with (masked — set in index.ts) so the dashboard can show it. */
let active: { dataSource: string; trades: string | null; grpc: string | null; from: { trades: string; grpc: string } } | null = null;
export function setActiveFeed(f: ReturnType<typeof effectiveFeed>): void {
  active = { dataSource: f.dataSource, trades: maskUrl(f.tradesWsUrl), grpc: maskUrl(f.grpcEndpoint ?? null), from: f.from };
}
export const activeFeed = () => active;
