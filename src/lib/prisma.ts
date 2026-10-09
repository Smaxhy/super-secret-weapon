/** Single shared Prisma client (one connection pool for the whole process). */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }],
});
