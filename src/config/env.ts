/**
 * Environment variables, loaded from `.env` and validated at startup.
 *
 * Every secret (API keys, private keys, DB passwords) comes from here and ONLY
 * from here. If something required is missing the bot refuses to start and
 * tells you exactly which variable is wrong, instead of crashing later.
 */
import 'dotenv/config';
import { z } from 'zod';

/** Treat empty strings in .env as "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

/** Parse "true"/"false"/"1"/"0" into a real boolean. */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['true', '1', 'yes'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  HELIUS_API_KEY: optionalString,
  RPC_HTTP_URL: optionalString,
  RPC_WS_URL: optionalString,
  RPC_MAX_RPS: z.coerce.number().positive().default(8),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  TRADING_MODE: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(['PAPER', 'LIVE'])).default('PAPER'),
  /** Live trading wallet secret (base58 or JSON byte array). Only in the VPS .env — never in git, logs or the API. */
  WALLET_SECRET: optionalString,
  /** Older name for the same secret. */
  BOT_WALLET_PRIVATE_KEY: optionalString,
  /** Helius Sender URL (dual route validators + Jito); needs LIVE_TIP_ACCOUNTS. */
  LIVE_SENDER_URL: optionalString,
  /** Tip accounts for the Sender, comma-separated (from Helius docs). */
  LIVE_TIP_ACCOUNTS: optionalString,
  /** MEV-protected send endpoint (e.g. FluxRPC shield) — plain JSON-RPC sendTransaction. */
  LIVE_SHIELD_URL: optionalString,

  API_PORT: z.coerce.number().int().default(8080),
  DASHBOARD_PASSWORD: optionalString,
  JWT_SECRET: optionalString,
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /**
   * Where live launches/trades come from:
   *   hybrid (default)     — PumpPortal for launches + Solana's public node for
   *                          trades. Free, no Helius credits.
   *   pumpportal           — PumpPortal only (its per-token trade feed)
   *   helius               — logsSubscribe on your Helius key (uses LOTS of credits)
   *   grpc                 — PumpPortal for launches + a PAID Yellowstone gRPC stream for trades
   *                          (GRPC_ENDPOINT + GRPC_TOKEN; the free stream stays on as a backup)
   */
  DATA_SOURCE: z.enum(['hybrid', 'pumpportal', 'helius', 'grpc']).default('hybrid'),
  /** Yellowstone gRPC endpoint incl. https:// and port, e.g. https://yellowstone-solana-mainnet.core.chainstack.com:443 */
  GRPC_ENDPOINT: optionalString,
  /** Its x-token (Chainstack: the node's auth token). */
  GRPC_TOKEN: optionalString,
  /** Free WebSocket for the trade stream in hybrid mode (Solana's public node by default). */
  TRADES_WS_URL: z.string().default('wss://api.mainnet-beta.solana.com'),
  /** Optional second FREE node the feed watchdog switches to when the main free trade stream keeps dying. */
  TRADES_WS_URL_BACKUP: z.string().default(''),
  PUMPPORTAL_API_KEY: optionalString,
  ENABLE_SCANNER: bool(true),
  ENABLE_SAFETY_CHECKS: bool(true),
  ENABLE_OBSERVATIONS: bool(true),

  ML_SERVICE_URL: optionalString,
  TWITTER_BEARER_TOKEN: optionalString,
  /** Solscan Pro API key (wallet analyzer). Limited credits — calls are capped per day. */
  SOLSCAN_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Plain console here: the logger itself depends on env.
    console.error(`\n[config] Invalid environment variables:\n${problems}\n\nCheck your .env file (see .env.example).\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/**
 * Resolve RPC endpoints. Explicit overrides win; otherwise build Helius URLs
 * from the API key. Returns undefined fields if nothing is configured, and the
 * caller decides whether that's fatal.
 */
export function rpcEndpoints(): { http?: string; ws?: string } {
  const key = env.HELIUS_API_KEY;
  return {
    http: env.RPC_HTTP_URL ?? (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined),
    ws: env.RPC_WS_URL ?? (key ? `wss://mainnet.helius-rpc.com/?api-key=${key}` : undefined),
  };
}

/** Strip API keys out of a URL before it goes anywhere near a log line. */
export function redactUrl(url: string): string {
  // ?api-key=… query keys, user:pass@ and key-in-the-path addresses (Chainstack: wss://host/<key>).
  return url
    .replace(/(api[-_]?key=)[^&]+/gi, '$1***')
    .replace(/\/\/[^@/]+@/, '//***@')
    .replace(/^(wss?:\/\/[^/?#]+)\/[^?#]{12,}/i, '$1/***');
}
