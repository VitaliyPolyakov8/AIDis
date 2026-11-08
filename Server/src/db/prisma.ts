import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Creates the Prisma client backed by node-postgres. A small pool is plenty
 * for a handful of users and keeps idle resource usage low.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
  return new PrismaClient({ adapter });
}

/** Prisma error code for unique constraint violations. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
