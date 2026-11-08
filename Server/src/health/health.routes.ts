import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const SERVER_VERSION = readVersion();

/**
 * GET /health  liveness: the process is up and serving HTTP.
 * GET /ready   readiness: PostgreSQL answers a trivial query.
 * Neither endpoint reveals configuration, secrets or error details.
 */
export function healthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', { config: { rateLimit: false } }, () => {
    return { status: 'ok' };
  });

  // 0.5.1: the API version (package.json), for "About" screens and deployment checks.
  app.get('/api/v1/version', { config: { rateLimit: false } }, () => ({ version: SERVER_VERSION }));

  app.get('/ready', { config: { rateLimit: false } }, async (request, reply) => {
    try {
      await ctx.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', checks: { database: 'ok' } };
    } catch (error) {
      request.log.error({ err: error, event: 'health.database_unreachable' }, 'Readiness check failed: database');
      return reply.status(503).send({ status: 'not_ready', checks: { database: 'unavailable' } });
    }
  });
}
