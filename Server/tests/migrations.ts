import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

/**
 * Applies the Prisma migration folders in order to a PGlite database.
 * `until`: stop before (not including) that folder; `only`: apply just that folder.
 */
export async function applyMigrations(pg: PGlite, opts: { until?: string; only?: string } = {}): Promise<void> {
  const dir = path.resolve('prisma/migrations');
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  entries.sort();
  for (const name of entries) {
    if (opts.until !== undefined && name >= opts.until) break;
    if (opts.only !== undefined && name !== opts.only) continue;
    await pg.exec(await readFile(path.join(dir, name, 'migration.sql'), 'utf8'));
  }
}
