import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';

export function presenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** 0.7.0: presence of the people the caller may see only. */
  app.get('/presence', { preHandler: ctx.hooks.requireAuth }, async (request) => {
    const visible = await ctx.services.friends.visibleUserIds(getAuth(request).user);
    const all = await ctx.services.presence.snapshot();
    return { presence: visible === 'all' ? all : all.filter((p) => visible.has(p.userId)) };
  });
}
