import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';

/** First-run wizard (public until the first account exists; see SetupService). */
export function setupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { setup } = ctx.services;

  app.get('/setup/status', async () => ({ needed: await setup.needed() }));

  app.post('/setup/complete', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => setup.complete(request.body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }));
}
