import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { applyMigrations } from './migrations.js';

/** A migrated in-memory database with a Prisma client, without building the app. */
export async function createDb(): Promise<{ prisma: PrismaClient; close: () => Promise<void> }> {
  const pg = new PGlite();
  await applyMigrations(pg);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await pg.close();
    },
  };
}

let counter = 0;
export async function dbUser(prisma: PrismaClient, name: string, role: 'ADMIN' | 'USER' = 'USER', disabled = false) {
  counter += 1;
  return prisma.user.create({ data: { username: name, usernameNormalized: `${name.toLowerCase()}-${counter}`, displayName: name, passwordHash: 'x', role, disabled } });
}
