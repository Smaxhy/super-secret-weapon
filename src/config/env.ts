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

  TRADING_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),
  BOT_WALLET_PRIVATE_KEY: optionalString,

  API_PORT: z.coerce.number().int().default(8080),
  DASHBOARD_PASSWORD: optionalString,
  JWT_SECRET: optionalString,
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /**
   * Where live launches/trades come from:
   *   pumpportal (default) — free, no Helius credits
   *   helius               — logsSubscribe on your Helius key (uses LOTS of credits)
   */
  DATA_SOURCE: z.enum(['pumpportal', 'helius']).default('pumpportal'),
  PUMPPORTAL_API_KEY: optionalString,
  ENABLE_SCANNER: bool(true),
  ENABLE_SAFETY_CHECKS: bool(true),
  ENABLE_OBSERVATIONS: bool(true),

  ML_SERVICE_URL: optionalString,
  TWITTER_BEARER_TOKEN: optionalString,
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
  return url.replace(/(api[-_]?key=)[^&]+/gi, '$1***');
}
