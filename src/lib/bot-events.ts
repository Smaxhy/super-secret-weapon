/**
 * Audit log of meaningful decisions ("why did the bot do that?").
 * Goes to the BotEvent table, which the dashboard reads. Never throws.
 */
import type { LogLevel, Prisma } from '@prisma/client';
import { moduleLogger } from './logger';
import { prisma } from './prisma';

const log = moduleLogger('bot-events');

export async function recordEvent(e: {
  level?: LogLevel;
  module: string;
  type: string;
  message: string;
  mint?: string;
  data?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.botEvent.create({
      data: { level: e.level ?? 'INFO', module: e.module, type: e.type, message: e.message, mint: e.mint, data: e.data },
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: e.type }, 'failed to record bot event');
  }
}
