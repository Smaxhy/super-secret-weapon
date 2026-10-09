/**
 * Central logger (pino). Fast, structured JSON in production, pretty colours
 * in development. Use `logger.child({ module: 'name' })` per module so every
 * line says where it came from.
 */
import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Never let a secret slip into the logs, even if someone logs a whole config object.
  redact: {
    paths: ['*.privateKey', '*.BOT_WALLET_PRIVATE_KEY', '*.HELIUS_API_KEY', '*.apiKey', '*.password', '*.JWT_SECRET'],
    censor: '***',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined,
});

export function moduleLogger(module: string) {
  return logger.child({ module });
}
